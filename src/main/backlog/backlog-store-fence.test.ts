// The fenced read-modify-write: a competing writer, an unreadable file or an event-log rewrite must
// never publish, and every refusal leaves the bytes on disk exactly as they were.

import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type * as NodeFsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { BacklogItem, BacklogItemEvent } from '../../shared/backlog-types'
import { BACKLOG_ITEM_CODEC } from './backlog-item-validation'
import type { BacklogFoldContext } from './backlog-record-store'
import { BacklogRecordStore } from './backlog-record-store'
import { BacklogService } from './backlog-service'

const renameFault = vi.hoisted(() => ({ code: null as string | null }))

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof NodeFsPromises>('node:fs/promises')
  return {
    ...actual,
    rename: async (...args: Parameters<typeof NodeFsPromises.rename>) => {
      if (renameFault.code !== null) {
        throw Object.assign(new Error(`simulated ${renameFault.code}`), { code: renameFault.code })
      }
      return actual.rename(...args)
    }
  }
})

let root: string
let store: BacklogRecordStore<BacklogItem>
let seed: BacklogItem

const sha = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex')
const itemPath = (): string => join(root, 'items', `${seed.id}.json`)

function appended(ctx: BacklogFoldContext): BacklogItemEvent {
  return { id: ctx.mintEventId(), type: 'updated', at: ctx.now, data: { fields: ['priority'] } }
}

function bump(current: BacklogItem, ctx: BacklogFoldContext): BacklogItem {
  return { ...current, priority: 'high', events: [...current.events, appended(ctx)] }
}

beforeEach(async () => {
  renameFault.code = null
  root = mkdtempSync(join(tmpdir(), 'orca-backlog-fence-'))
  const captured = await new BacklogService(() => root).capture({ text: 'seed', kind: 'engineering' })
  if (captured.outcome !== 'published') {
    throw new Error(`precondition: seed capture returned ${captured.outcome}`)
  }
  seed = captured.record
  store = new BacklogRecordStore(join(root, 'items'), BACKLOG_ITEM_CODEC, () => 5_000)
  // Precondition, so a seed failure is never misread as a fence defect.
  expect((await store.load(seed.id)).outcome).toBe('loaded')
})

afterEach(() => {
  renameFault.code = null
  rmSync(root, { recursive: true, force: true })
})

describe('BacklogRecordStore.mutate', () => {
  it('publishes one appended event, stamps revision + 1 and keeps unknown fields', async () => {
    const raw = JSON.parse(readFileSync(itemPath(), 'utf-8')) as Record<string, unknown>
    writeFileSync(itemPath(), `${JSON.stringify({ ...raw, futureField: 'kept' }, null, 2)}\n`)

    const outcome = await store.mutate(seed.id, (current, ctx) => ({ ...bump(current, ctx), revision: 99 }))

    expect(outcome.outcome).toBe('published')
    const onDisk = JSON.parse(readFileSync(itemPath(), 'utf-8')) as Record<string, unknown>
    expect(onDisk.revision).toBe(2)
    expect(onDisk.priority).toBe('high')
    expect(onDisk.futureField).toBe('kept')
    expect((onDisk.events as unknown[]).length).toBe(2)
  })

  it('is superseded by a competing write positioned inside the fold; the newer bytes survive', async () => {
    const outcome = await store.mutate(seed.id, (current, ctx) => {
      const competitor = { ...current, normalizedIntent: 'competitor', revision: current.revision + 1 }
      writeFileSync(itemPath(), `${JSON.stringify(competitor, null, 2)}\n`)
      return bump(current, ctx)
    })

    expect(outcome).toEqual({ outcome: 'superseded', expectedRevision: 1, actualRevision: 2 })
    const onDisk = JSON.parse(readFileSync(itemPath(), 'utf-8')) as BacklogItem
    expect(onDisk.revision).toBe(2)
    expect(onDisk.normalizedIntent).toBe('competitor')
  })

  it('is superseded with actualRevision -1 when the file turns unreadable mid-mutate', async () => {
    let garbageSha = ''
    const outcome = await store.mutate(seed.id, (current, ctx) => {
      writeFileSync(itemPath(), 'not json at all')
      garbageSha = sha(itemPath())
      return bump(current, ctx)
    })

    expect(outcome).toEqual({ outcome: 'superseded', expectedRevision: 1, actualRevision: -1 })
    expect(sha(itemPath())).toBe(garbageSha)
  })

  it('answers absent for an id that was never captured', async () => {
    const outcome = await store.mutate('bli_00000000-0000-4000-8000-000000000000', bump)
    expect(outcome).toEqual({ outcome: 'absent' })
  })

  it('answers unchanged when the fold returns the same object, bytes untouched', async () => {
    const before = sha(itemPath())
    const outcome = await store.mutate(seed.id, (current) => current)
    expect(outcome.outcome).toBe('unchanged')
    expect(sha(itemPath())).toBe(before)
  })

  it('answers schema-too-new without writing', async () => {
    const raw = JSON.parse(readFileSync(itemPath(), 'utf-8')) as Record<string, unknown>
    writeFileSync(itemPath(), `${JSON.stringify({ ...raw, schemaVersion: 2 }, null, 2)}\n`)
    const before = sha(itemPath())

    const outcome = await store.mutate(seed.id, bump)

    expect(outcome).toEqual({ outcome: 'schema-too-new', storedVersion: 2 })
    expect(sha(itemPath())).toBe(before)
  })

  it.each([
    [
      'drops an event',
      'event-log-not-extended',
      (_c: BacklogItem, ctx: BacklogFoldContext) => [appended(ctx)]
    ],
    [
      'edits a stored event',
      'event-log-not-extended',
      (c: BacklogItem, ctx: BacklogFoldContext) => [{ ...c.events[0], at: -1 }, appended(ctx)]
    ],
    ['appends none', 'event-count', (c: BacklogItem) => [...c.events]],
    [
      'appends two',
      'event-count',
      (c: BacklogItem, ctx: BacklogFoldContext) => [...c.events, appended(ctx), appended(ctx)]
    ]
  ] as const)('refuses a fold that %s, bytes untouched', async (_label, code, events) => {
    const before = sha(itemPath())
    const outcome = await store.mutate(seed.id, (current, ctx) => ({
      ...current,
      priority: 'low',
      events: events(current, ctx)
    }))
    expect(outcome).toMatchObject({ outcome: 'refused', code })
    expect(sha(itemPath())).toBe(before)
  })

  it('refuses a reordered event log', async () => {
    const first = await store.mutate(seed.id, bump)
    expect(first.outcome).toBe('published')
    const before = sha(itemPath())

    const outcome = await store.mutate(seed.id, (current, ctx) => ({
      ...current,
      events: [current.events[1], current.events[0], appended(ctx)]
    }))

    expect(outcome).toMatchObject({ outcome: 'refused', code: 'event-log-not-extended' })
    expect(sha(itemPath())).toBe(before)
  })

  it('returns storage-failed at publish when the rename throws, prior bytes intact', async () => {
    const before = sha(itemPath())
    renameFault.code = 'EPERM'

    const outcome = await store.mutate(seed.id, bump)

    expect(outcome).toEqual({ outcome: 'storage-failed', stage: 'publish', code: 'EPERM' })
    expect(sha(itemPath())).toBe(before)
  })

  it('returns storage-failed at prepare when the items directory cannot be created', async () => {
    const blocked = mkdtempSync(join(tmpdir(), 'orca-backlog-prepare-'))
    try {
      writeFileSync(join(blocked, 'items'), 'a regular file where the directory should be')
      const outcome = await new BacklogService(() => blocked).capture({ text: 'x', kind: 'idea' })
      expect(outcome).toMatchObject({ outcome: 'storage-failed', stage: 'prepare' })
      expect((outcome as { code: string | null }).code).not.toBeNull()
    } finally {
      rmSync(blocked, { recursive: true, force: true })
    }
  })
})
