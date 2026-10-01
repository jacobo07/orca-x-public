import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { isBacklogCandidateId, isBacklogItemId } from '../../shared/backlog-identity'
import type { BacklogCandidate } from '../../shared/backlog-types'
import type { BacklogCandidateIngestEntry } from './backlog-candidate-operations'
import { deriveBacklogCandidateId, mintItemIdForCandidate } from './backlog-identity-mint'
import { BacklogService } from './backlog-service'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-backlog-ingest-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function entry(overrides: Partial<BacklogCandidateIngestEntry> = {}): BacklogCandidateIngestEntry {
  return {
    source: {
      kind: 'orca-conversation',
      ref: 'conv_1',
      capturedAt: 1_000,
      adapter: 'orca-conversations',
      capabilityLevel: 'full'
    },
    fingerprint: 'fp-1',
    text: '  Wire the ledger to the rail  ',
    uncertainty: 'medium',
    ...overrides
  }
}

function candidateFiles(): string[] {
  return readdirSync(join(root, 'candidates')).filter((name) => name.endsWith('.json'))
}

describe('candidate identity derivation', () => {
  it('derives a stable candidate id that moves with every component', () => {
    const id = deriveBacklogCandidateId('orca-conversation', 'conv_1', 'fp')
    expect(deriveBacklogCandidateId('orca-conversation', 'conv_1', 'fp')).toBe(id)
    expect(isBacklogCandidateId(id)).toBe(true)
    expect(deriveBacklogCandidateId('codex-transcript', 'conv_1', 'fp')).not.toBe(id)
    expect(deriveBacklogCandidateId('orca-conversation', 'conv_2', 'fp')).not.toBe(id)
    expect(deriveBacklogCandidateId('orca-conversation', 'conv_1', 'fq')).not.toBe(id)
  })

  it('throws on a NUL in any component', () => {
    expect(() => deriveBacklogCandidateId('orca-conversation', 'a\0b', 'fp')).toThrow()
    expect(() => deriveBacklogCandidateId('orca-conversation', 'conv', 'f\0p')).toThrow()
    expect(() => deriveBacklogCandidateId('orca\0conversation', 'conv', 'fp')).toThrow()
  })

  it('mints a stable UUID-shaped item id per candidate', () => {
    const a = deriveBacklogCandidateId('orca-conversation', 'conv_1', 'fp')
    const b = deriveBacklogCandidateId('orca-conversation', 'conv_1', 'fp2')
    expect(mintItemIdForCandidate(a)).toBe(mintItemIdForCandidate(a))
    expect(isBacklogItemId(mintItemIdForCandidate(a))).toBe(true)
    expect(mintItemIdForCandidate(b)).not.toBe(mintItemIdForCandidate(a))
  })
})

describe('idempotent candidate ingest', () => {
  it('publishes once, then answers unchanged with one file', async () => {
    const service = new BacklogService(() => root, { now: () => 5 })
    const [first] = await service.ingestCandidates([entry()])
    const [second] = await service.ingestCandidates([entry()])

    expect(first).toMatchObject({ index: 0, outcome: 'published', code: null })
    expect(second).toMatchObject({ index: 0, outcome: 'unchanged', id: first.id })
    expect(first.id).toBe(deriveBacklogCandidateId('orca-conversation', 'conv_1', 'fp-1'))
    expect(candidateFiles()).toHaveLength(1)
  })

  it('20 concurrent ingests of one fingerprint publish exactly once', async () => {
    const service = new BacklogService(() => root)
    const results = (
      await Promise.all(Array.from({ length: 20 }, () => service.ingestCandidates([entry()])))
    ).flat()

    expect(results.filter((row) => row.outcome === 'published')).toHaveLength(1)
    expect(results.filter((row) => row.outcome === 'unchanged')).toHaveLength(19)
    expect(candidateFiles()).toHaveLength(1)
  })

  it('stores an open candidate with one ingested event and trimmed text', async () => {
    const service = new BacklogService(() => root, { now: () => 42 })
    const [result] = await service.ingestCandidates([entry()])
    const stored = JSON.parse(
      readFileSync(join(root, 'candidates', `${result.id}.json`), 'utf-8')
    ) as BacklogCandidate

    expect(stored.status).toBe('open')
    expect(stored.resolvedItemId).toBeNull()
    expect(stored.projectHint).toBeNull()
    expect(stored.revision).toBe(1)
    expect(stored.text).toBe('Wire the ledger to the rail')
    expect(stored.source).toEqual(entry().source)
    expect(stored.fingerprint).toBe('fp-1')
    expect(stored.events.map((event) => event.type)).toEqual(['ingested'])
    expect(stored.events[0].data).toMatchObject({ adapter: 'orca-conversations' })
  })

  it('gives a different id to the same fingerprint under another ref or kind', async () => {
    const service = new BacklogService(() => root)
    const results = await service.ingestCandidates([
      entry(),
      entry({ source: { ...entry().source, ref: 'conv_2' } }),
      entry({ source: { ...entry().source, kind: 'codex-transcript' } })
    ])
    expect(results.map((row) => row.outcome)).toEqual(['published', 'published', 'published'])
    expect(new Set(results.map((row) => row.id)).size).toBe(3)
    expect(candidateFiles()).toHaveLength(3)
  })

  it('refuses a NUL entry without aborting the rest of the batch', async () => {
    const service = new BacklogService(() => root)
    const results = await service.ingestCandidates([
      entry({ fingerprint: 'bad\0fp' }),
      entry({ fingerprint: 'fp-ok' })
    ])
    expect(results[0]).toEqual({
      index: 0,
      id: null,
      outcome: 'refused',
      code: 'invalid-record'
    })
    expect(results[1]).toMatchObject({ index: 1, outcome: 'published' })
    expect(candidateFiles()).toHaveLength(1)
  })

  it('re-ingest after dismiss stays dismissed with one file', async () => {
    const service = new BacklogService(() => root)
    const [first] = await service.ingestCandidates([entry()])
    await service.resolveCandidate({ action: 'dismiss', candidateId: first.id! })

    const [again] = await service.ingestCandidates([entry()])

    expect(again).toMatchObject({ outcome: 'unchanged', id: first.id })
    const stored = JSON.parse(
      readFileSync(join(root, 'candidates', `${first.id}.json`), 'utf-8')
    ) as BacklogCandidate
    expect(stored.status).toBe('dismissed')
    expect(candidateFiles()).toHaveLength(1)
  })

  it('never echoes candidate text in a result row', async () => {
    const service = new BacklogService(() => root)
    const results = await service.ingestCandidates([entry()])
    expect(Object.keys(results[0]).sort()).toEqual(['code', 'id', 'index', 'outcome'])
    expect(JSON.stringify(results)).not.toContain('Wire the ledger')
  })
})
