// A created-then-mutated item survives into a fresh service instance: the reload reads what the
// fenced publish wrote, not what an instance happened to hold in memory.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'

import type { BacklogItem } from '../../shared/backlog-types'
import { BACKLOG_ITEM_CODEC } from './backlog-item-validation'
import { BacklogRecordStore } from './backlog-record-store'
import { BacklogService } from './backlog-service'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-backlog-durable-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

it('reloads a created-then-mutated item deep-equal at revision 2', async () => {
  const captured = await new BacklogService(() => root).capture({ text: 'persist me', kind: 'research' })
  if (captured.outcome !== 'published') {
    throw new Error(`precondition: capture returned ${captured.outcome}`)
  }
  const store = new BacklogRecordStore<BacklogItem>(join(root, 'items'), BACKLOG_ITEM_CODEC, () => 9)

  const mutated = await store.mutate(captured.record.id, (current, ctx) => ({
    ...current,
    priority: 'urgent',
    updatedAt: ctx.now,
    events: [...current.events, { id: ctx.mintEventId(), type: 'updated', at: ctx.now, data: {} }]
  }))
  if (mutated.outcome !== 'published') {
    throw new Error(`mutate returned ${mutated.outcome}`)
  }

  const reloaded = await new BacklogService(() => root).get(captured.record.id)

  expect(mutated.record.revision).toBe(2)
  expect(reloaded).toEqual({ outcome: 'loaded', record: mutated.record })
})
