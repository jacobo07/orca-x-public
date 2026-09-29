import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { BacklogItem } from '../../shared/backlog-types'
import type * as RecordFile from './backlog-record-file'
import type { BacklogService as BacklogServiceType } from './backlog-service'

const fault = vi.hoisted(() => ({ id: null as string | null }))

vi.mock('./backlog-record-file', async (importOriginal) => {
  const actual = await importOriginal<typeof RecordFile>()
  return {
    ...actual,
    publishBacklogRevision: (async (finalPath, payload, expectedRevision) =>
      fault.id !== null && finalPath.includes(fault.id)
        ? { outcome: 'storage-failed', stage: 'publish', code: 'EIO' }
        : actual.publishBacklogRevision(
            finalPath,
            payload,
            expectedRevision
          )) as typeof actual.publishBacklogRevision
  }
})

let root: string
let service: BacklogServiceType

beforeEach(async () => {
  fault.id = null
  root = mkdtempSync(join(tmpdir(), 'orca-backlog-merge-'))
  const { BacklogService } = await import('./backlog-service')
  service = new BacklogService(() => root, { now: () => 11 })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const pathOf = (id: string): string => join(root, 'items', `${id}.json`)
const readItem = (id: string): BacklogItem =>
  JSON.parse(readFileSync(pathOf(id), 'utf-8')) as BacklogItem
const sha = (id: string): string => createHash('sha256').update(readFileSync(pathOf(id))).digest('hex')

async function capture(text: string, initialState?: 'ready'): Promise<BacklogItem> {
  const outcome = await service.capture({ text, kind: 'engineering', initialState })
  if (outcome.outcome !== 'published') {
    throw new Error(`precondition: capture returned ${outcome.outcome}`)
  }
  return outcome.record
}

async function withLinks(item: BacklogItem, refs: string[]): Promise<BacklogItem> {
  const outcome = await service.update(item.id, {
    addExecutionLinks: refs.map((ref) => ({ kind: 'github-issue' as const, ref }))
  })
  if (outcome.outcome !== 'published') {
    throw new Error(`precondition: update returned ${outcome.outcome}`)
  }
  return outcome.record
}

describe('item -> item merge', () => {
  it('unions every link into the survivor and supersedes the loser; retry is unchanged', async () => {
    const survivor = await withLinks(await capture('Survivor'), ['#1', '#2'])
    const loser = await withLinks(await capture('Loser'), ['#2', '#3'])

    const result = await service.mergeItems({ survivorId: survivor.id, loserId: loser.id })

    expect(result.survivor).toMatchObject({ outcome: 'published' })
    expect(result.loser).toMatchObject({ outcome: 'published' })
    const kept = readItem(survivor.id)
    const sourceKeys = kept.sourceLinks.map((link) => `${link.kind}|${link.ref}|${link.candidateId}`)
    for (const link of [...survivor.sourceLinks, ...loser.sourceLinks]) {
      const key = `${link.kind}|${link.ref}|${link.candidateId}`
      expect(sourceKeys.filter((have) => have === key)).toHaveLength(1)
    }
    const executionKeys = kept.executionLinks.map((link) => `${link.kind}|${link.ref}`)
    for (const link of [...survivor.executionLinks, ...loser.executionLinks]) {
      const key = `${link.kind}|${link.ref}`
      expect(executionKeys.filter((have) => have === key)).toHaveLength(1)
    }
    expect(kept.executionLinks).toHaveLength(3)
    expect(kept.events.filter((event) => event.type === 'merged-in')).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ from: loser.id }) })
    ])
    const gone = readItem(loser.id)
    expect(gone.state).toBe('superseded')
    expect(gone.mergedInto).toBe(survivor.id)
    expect(gone.events.filter((event) => event.type === 'merged-into')).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({ into: survivor.id, previousState: 'needs-triage' })
      })
    ])

    const again = await service.mergeItems({ survivorId: survivor.id, loserId: loser.id })
    expect(again.survivor).toMatchObject({ outcome: 'unchanged' })
    expect(again.loser).toMatchObject({ outcome: 'unchanged' })
  })

  it('a failed loser leg leaves the survivor holding the union and the loser active', async () => {
    const survivor = await capture('Survivor')
    const loser = await capture('Loser')
    fault.id = loser.id

    const result = await service.mergeItems({ survivorId: survivor.id, loserId: loser.id })

    expect(result.survivor).toMatchObject({ outcome: 'published' })
    expect(result.loser).toEqual({ outcome: 'storage-failed', stage: 'publish', code: 'EIO' })
    expect(readItem(survivor.id).sourceLinks).toHaveLength(2)
    expect(readItem(loser.id).state).not.toBe('superseded')
    expect(readItem(loser.id).mergedInto).toBeNull()

    fault.id = null
    const retried = await service.mergeItems({ survivorId: survivor.id, loserId: loser.id })
    expect(retried.survivor).toMatchObject({ outcome: 'unchanged' })
    expect(retried.loser).toMatchObject({ outcome: 'published' })
    expect(readItem(loser.id).state).toBe('superseded')
  })

  it('refuses a self-merge before any write', async () => {
    const item = await capture('Only one')
    const before = sha(item.id)

    const result = await service.mergeItems({ survivorId: item.id, loserId: item.id })

    expect(result).toEqual({
      survivor: { outcome: 'refused', code: 'self-merge', detail: null },
      loser: null
    })
    expect(sha(item.id)).toBe(before)
  })

  it('refuses a running loser as illegal-transition with both files untouched', async () => {
    const survivor = await capture('Survivor')
    const loser = await capture('Running loser', 'ready')
    await service.transition(loser.id, { to: 'running' })
    const before = [sha(survivor.id), sha(loser.id)]

    const result = await service.mergeItems({ survivorId: survivor.id, loserId: loser.id })

    expect(result.survivor).toMatchObject({ outcome: 'refused', code: 'illegal-transition' })
    expect(result.loser).toBeNull()
    expect([sha(survivor.id), sha(loser.id)]).toEqual(before)
  })

  it('refuses a done loser as illegal-transition with both files untouched', async () => {
    const survivor = await capture('Survivor')
    const loser = await capture('Done loser', 'ready')
    const evidence = (subject: 'revision' | 'gate') => ({
      class: 'OBSERVED' as const,
      origin: 'tool' as const,
      subject,
      source: 'ci',
      ref: 'abc'
    })
    await service.update(loser.id, { addEvidence: [evidence('revision'), evidence('gate')] })
    const done = await service.transition(loser.id, { to: 'done' })
    expect(done.outcome).toBe('published')
    const before = [sha(survivor.id), sha(loser.id)]

    const result = await service.mergeItems({ survivorId: survivor.id, loserId: loser.id })

    expect(result.survivor).toMatchObject({ outcome: 'refused', code: 'illegal-transition' })
    expect([sha(survivor.id), sha(loser.id)]).toEqual(before)
  })

  it('refuses a loser already superseded into a different survivor', async () => {
    const first = await capture('First')
    const second = await capture('Second')
    const loser = await capture('Loser')
    await service.mergeItems({ survivorId: first.id, loserId: loser.id })
    const before = [sha(second.id), sha(loser.id)]

    const result = await service.mergeItems({ survivorId: second.id, loserId: loser.id })

    expect(result.survivor).toMatchObject({ outcome: 'refused', code: 'illegal-transition' })
    expect([sha(second.id), sha(loser.id)]).toEqual(before)
  })

  it('opposite merges started together both settle without deadlock', async () => {
    const a = await capture('A')
    const b = await capture('B')

    const settled = await Promise.allSettled([
      service.mergeItems({ survivorId: a.id, loserId: b.id }),
      service.mergeItems({ survivorId: b.id, loserId: a.id })
    ])

    expect(settled.map((entry) => entry.status)).toEqual(['fulfilled', 'fulfilled'])
    const results = settled.map((entry) => (entry.status === 'fulfilled' ? entry.value : null))
    expect(
      results.filter(
        (row) => row?.survivor.outcome === 'published' && row.loser?.outcome === 'published'
      )
    ).toHaveLength(1)
    expect(
      results.filter(
        (row) =>
          row?.survivor.outcome === 'refused' &&
          'code' in row.survivor &&
          row.survivor.code === 'merge-target-superseded'
      )
    ).toHaveLength(1)
  }, 10_000)
})
