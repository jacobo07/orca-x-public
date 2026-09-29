import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { BacklogCandidate, BacklogItem } from '../../shared/backlog-types'
import type { BacklogCandidateIngestEntry } from './backlog-candidate-operations'
import type * as RecordFile from './backlog-record-file'
import type { BacklogService as BacklogServiceType } from './backlog-service'

// Boundary fault: a revision publish whose final path names this id reports storage-failed.
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
let mintItemIdForCandidate: (candidateId: string) => string

beforeEach(async () => {
  fault.id = null
  root = mkdtempSync(join(tmpdir(), 'orca-backlog-resolve-'))
  const { BacklogService } = await import('./backlog-service')
  ;({ mintItemIdForCandidate } = await import('./backlog-identity-mint'))
  service = new BacklogService(() => root, { now: () => 7 })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function entry(fingerprint: string, extra: Partial<BacklogCandidateIngestEntry> = {}) {
  return {
    source: {
      kind: 'claude-code-transcript' as const,
      ref: 'session-1',
      capturedAt: 3,
      adapter: 'claude-transcripts',
      capabilityLevel: 'best-effort' as const
    },
    fingerprint,
    text: `Intent ${fingerprint}`,
    uncertainty: 'low' as const,
    ...extra
  }
}

async function ingest(fingerprint: string, extra: Partial<BacklogCandidateIngestEntry> = {}) {
  const [result] = await service.ingestCandidates([entry(fingerprint, extra)])
  if (result.outcome !== 'published' || result.id === null) {
    throw new Error(`precondition: ingest returned ${result.outcome}`)
  }
  return result.id
}

function readJson<T>(directory: string, id: string): T {
  return JSON.parse(readFileSync(join(root, directory, `${id}.json`), 'utf-8')) as T
}

function itemFiles(): string[] {
  return readdirSync(join(root, 'items')).filter((name) => name.endsWith('.json'))
}

async function capture(text: string): Promise<BacklogItem> {
  const outcome = await service.capture({ text, kind: 'engineering' })
  if (outcome.outcome !== 'published') {
    throw new Error(`precondition: capture returned ${outcome.outcome}`)
  }
  return outcome.record
}

describe('accept', () => {
  it('creates the derived item from the candidate and marks the candidate accepted', async () => {
    const candidateId = await ingest('fp-a', {
      projectHint: { projectId: 'orca', evidence: 'cwd was the orca repo' }
    })

    const result = await service.resolveCandidate({ action: 'accept', candidateId })

    const itemId = mintItemIdForCandidate(candidateId)
    expect(result.item).toMatchObject({ outcome: 'published' })
    expect(result.candidate).toMatchObject({ outcome: 'published' })
    const item = readJson<BacklogItem>('items', itemId)
    expect(item.kind).toBe('idea')
    expect(item.state).toBe('needs-triage')
    expect(item.originalText).toBe('Intent fp-a')
    expect(item.projectRefs).toEqual([
      { projectId: 'orca', mapping: 'inferred', evidence: 'cwd was the orca repo' }
    ])
    expect(item.sourceLinks).toEqual([
      { kind: 'claude-code-transcript', ref: 'session-1', capturedAt: 3, candidateId }
    ])
    expect(item.events.map((event) => event.type)).toEqual(['created'])
    expect(item.events[0].data).toMatchObject({ origin: 'candidate', candidateId })
    const candidate = readJson<BacklogCandidate>('candidates', candidateId)
    expect(candidate.status).toBe('accepted')
    expect(candidate.resolvedItemId).toBe(itemId)
    expect(candidate.events.map((event) => event.type)).toEqual(['ingested', 'resolved'])
  })

  it('lets explicit projectRefs replace the hint', async () => {
    const candidateId = await ingest('fp-b', { projectHint: { projectId: 'orca', evidence: '' } })
    const projectRefs = [{ projectId: 'kobii', mapping: 'explicit' as const, evidence: 'owner said' }]

    await service.resolveCandidate({ action: 'accept', candidateId, projectRefs, kind: 'research' })

    const item = readJson<BacklogItem>('items', mintItemIdForCandidate(candidateId))
    expect(item.projectRefs).toEqual(projectRefs)
    expect(item.kind).toBe('research')
  })

  it('is idempotent: a second accept leaves one item and both legs unchanged', async () => {
    const candidateId = await ingest('fp-c')
    await service.resolveCandidate({ action: 'accept', candidateId })

    const again = await service.resolveCandidate({ action: 'accept', candidateId })

    expect(again.item).toMatchObject({ outcome: 'unchanged' })
    expect(again.candidate).toMatchObject({ outcome: 'unchanged' })
    expect(itemFiles()).toHaveLength(1)
  })

  it('a failed candidate leg keeps the item; the retry completes without a second item', async () => {
    const candidateId = await ingest('fp-d')
    fault.id = candidateId

    const failed = await service.resolveCandidate({ action: 'accept', candidateId })

    expect(failed.item).toMatchObject({ outcome: 'published' })
    expect(failed.candidate).toEqual({ outcome: 'storage-failed', stage: 'publish', code: 'EIO' })
    expect(readJson<BacklogCandidate>('candidates', candidateId).status).toBe('open')

    fault.id = null
    const retried = await service.resolveCandidate({ action: 'accept', candidateId })

    expect(retried.item).toMatchObject({ outcome: 'unchanged' })
    expect(retried.candidate).toMatchObject({ outcome: 'published' })
    expect(readJson<BacklogCandidate>('candidates', candidateId).status).toBe('accepted')
    expect(itemFiles()).toHaveLength(1)
  })
})

describe('merge into an item', () => {
  it('appends one candidate source link and marks the candidate merged; repeat is unchanged', async () => {
    const item = await capture('Existing intent')
    const candidateId = await ingest('fp-m')

    const merged = await service.resolveCandidate({ action: 'merge', candidateId, itemId: item.id })

    expect(merged.item).toMatchObject({ outcome: 'published' })
    expect(merged.candidate).toMatchObject({ outcome: 'published' })
    const stored = readJson<BacklogItem>('items', item.id)
    expect(stored.sourceLinks).toHaveLength(2)
    expect(stored.sourceLinks.filter((link) => link.candidateId === candidateId)).toHaveLength(1)
    expect(stored.events.map((event) => event.type)).toEqual(['created', 'source-linked'])
    const candidate = readJson<BacklogCandidate>('candidates', candidateId)
    expect(candidate.status).toBe('merged')
    expect(candidate.resolvedItemId).toBe(item.id)

    const again = await service.resolveCandidate({ action: 'merge', candidateId, itemId: item.id })
    expect(again.item).toMatchObject({ outcome: 'unchanged' })
    expect(again.candidate).toMatchObject({ outcome: 'unchanged' })
  })

  it('refuses a superseded target and leaves the candidate open', async () => {
    const item = await capture('Old intent')
    await service.transition(item.id, { to: 'superseded' })
    const candidateId = await ingest('fp-s')

    const result = await service.resolveCandidate({ action: 'merge', candidateId, itemId: item.id })

    expect(result.item).toMatchObject({ outcome: 'refused', code: 'merge-target-superseded' })
    expect(result.candidate).toBeNull()
    expect(readJson<BacklogCandidate>('candidates', candidateId).status).toBe('open')
  })
})

describe('terminal resolutions', () => {
  it('dismiss, then accept is refused and creates no item', async () => {
    const candidateId = await ingest('fp-x')

    const dismissed = await service.resolveCandidate({ action: 'dismiss', candidateId, note: 'noise' })
    expect(dismissed).toMatchObject({ candidate: { outcome: 'published' }, item: null })
    expect(readJson<BacklogCandidate>('candidates', candidateId).status).toBe('dismissed')

    const accepted = await service.resolveCandidate({ action: 'accept', candidateId })
    expect(accepted.candidate).toMatchObject({
      outcome: 'refused',
      code: 'candidate-already-resolved'
    })
    expect(accepted.item).toBeNull()
    expect(existsSync(join(root, 'items', `${mintItemIdForCandidate(candidateId)}.json`))).toBe(
      false
    )
  })

  it('already-done and superseded set their statuses', async () => {
    const doneId = await ingest('fp-done')
    const supersededId = await ingest('fp-sup')

    await service.resolveCandidate({ action: 'already-done', candidateId: doneId })
    await service.resolveCandidate({ action: 'superseded', candidateId: supersededId })

    expect(readJson<BacklogCandidate>('candidates', doneId).status).toBe('already-done')
    expect(readJson<BacklogCandidate>('candidates', supersededId).status).toBe('superseded')
  })

  it('answers the load outcome for a candidate that was never ingested', async () => {
    const result = await service.resolveCandidate({
      action: 'dismiss',
      candidateId: `blc_${'0'.repeat(32)}`
    })
    expect(result).toEqual({ candidate: { outcome: 'absent' }, item: null })
  })
})
