// R-01: this build reads the schema range 1..2 and stamps each record with the lowest version that
// describes it, so a flat bump never hides the existing ledger from this build or an older one.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  BACKLOG_CANDIDATE_EVENT_TYPES,
  type BacklogCandidate,
  type BacklogItem
} from '../../shared/backlog-types'
import { parseBacklogCandidate } from './backlog-candidate-validation'
import { mintBacklogEventId, mintItemIdForCandidate } from './backlog-identity-mint'
import { openBacklogLedger } from './backlog-ledger-open'
import { parseBacklogEnvelope } from './backlog-record-envelope'
import { BacklogService } from './backlog-service'

const ID = 'rec-1'

function raw(schemaVersion: unknown): string {
  const record: Record<string, unknown> = { id: ID, revision: 1, events: [] }
  if (schemaVersion !== undefined) {
    record.schemaVersion = schemaVersion
  }
  return JSON.stringify(record)
}

describe('parseBacklogEnvelope version range', () => {
  it.each([1, 2])('loads schemaVersion %s', (version) => {
    expect(parseBacklogEnvelope(raw(version), ID, BACKLOG_CANDIDATE_EVENT_TYPES).outcome).toBe(
      'loaded'
    )
  })

  it('answers schema-too-new with the stored version for 3', () => {
    expect(parseBacklogEnvelope(raw(3), ID, BACKLOG_CANDIDATE_EVENT_TYPES)).toEqual({
      outcome: 'schema-too-new',
      storedVersion: 3
    })
  })

  it.each([
    ['0', 0],
    ['a non-integer', 1.5],
    ['a string', '1'],
    ['a missing version', undefined]
  ])('answers schema-too-old for %s', (_label, version) => {
    expect(parseBacklogEnvelope(raw(version), ID, BACKLOG_CANDIDATE_EVENT_TYPES)).toEqual({
      outcome: 'unreadable',
      code: 'schema-too-old',
      reason: 'schemaVersion is below the readable range'
    })
  })
})

let root: string
let service: BacklogService

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-backlog-envelope-'))
  service = new BacklogService(() => root, { now: () => 11 })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const source = {
  kind: 'orca-conversation' as const,
  ref: 'conv_1',
  capturedAt: 1,
  adapter: 'orca-conversations',
  capabilityLevel: 'full' as const
}

async function ingestOne(fingerprint: string): Promise<string> {
  const [result] = await service.ingestCandidates([
    { source, fingerprint, text: `intent ${fingerprint}`, uncertainty: 'low' }
  ])
  if (result.outcome !== 'published' || result.id === null) {
    throw new Error(`precondition: ingest returned ${result.outcome}`)
  }
  return result.id
}

function onDisk<T>(directory: string, id: string): T {
  return JSON.parse(readFileSync(join(root, directory, `${id}.json`), 'utf-8')) as T
}

function withHintAssigned(candidate: BacklogCandidate, schemaVersion: number): BacklogCandidate {
  return {
    ...candidate,
    schemaVersion,
    projectHint: { projectId: 'P1', evidence: 'assigned', mapping: 'explicit' },
    events: [
      ...candidate.events,
      {
        id: mintBacklogEventId(),
        type: 'hint-assigned',
        at: 12,
        data: { projectId: 'P1', previousProjectId: null }
      }
    ],
    revision: candidate.revision + 1
  }
}

describe('per-record stamping', () => {
  it('capture, ingest and accept all write schemaVersion 1 to disk', async () => {
    const captured = await service.capture({ text: 'manual', kind: 'engineering' })
    if (captured.outcome !== 'published') {
      throw new Error(`precondition: capture returned ${captured.outcome}`)
    }
    const candidateId = await ingestOne('fp-accept')
    const accepted = await service.resolveCandidate({ action: 'accept', candidateId })
    expect(accepted.item).toMatchObject({ outcome: 'published' })

    expect(onDisk<BacklogItem>('items', captured.record.id).schemaVersion).toBe(1)
    expect(onDisk<BacklogCandidate>('candidates', candidateId).schemaVersion).toBe(1)
    expect(onDisk<BacklogItem>('items', mintItemIdForCandidate(candidateId)).schemaVersion).toBe(1)
  })

  it('a v1 record still loads under the v2 build', async () => {
    const candidateId = await ingestOne('fp-v1')
    const text = readFileSync(join(root, 'candidates', `${candidateId}.json`), 'utf-8')
    expect(JSON.parse(text).schemaVersion).toBe(1)

    expect(parseBacklogCandidate(text, candidateId).outcome).toBe('loaded')
  })

  it.each([1, 2])('a hint-assigned event loads on a v%s candidate', async (version) => {
    const candidateId = await ingestOne(`fp-hint-${version}`)
    const next = withHintAssigned(onDisk<BacklogCandidate>('candidates', candidateId), version)

    expect(parseBacklogCandidate(JSON.stringify(next), candidateId)).toMatchObject({
      outcome: 'loaded',
      record: { schemaVersion: version, projectHint: { mapping: 'explicit' } }
    })
  })

  it('opens a ledger of one v1 item, one v1 candidate and one v2 candidate with no quarantine', async () => {
    const captured = await service.capture({ text: 'v1 item', kind: 'idea' })
    if (captured.outcome !== 'published') {
      throw new Error(`precondition: capture returned ${captured.outcome}`)
    }
    const v1Id = await ingestOne('fp-mixed-1')
    const v2Id = await ingestOne('fp-mixed-2')
    const v2 = withHintAssigned(onDisk<BacklogCandidate>('candidates', v2Id), 2)
    writeFileSync(join(root, 'candidates', `${v2Id}.json`), `${JSON.stringify(v2, null, 2)}\n`)

    const ledger = await openBacklogLedger(root)

    if (ledger.outcome !== 'opened') {
      throw new Error(`open returned ${ledger.outcome}`)
    }
    expect(ledger.quarantined).toEqual([])
    expect(ledger.items.map((item) => item.id)).toEqual([captured.record.id])
    expect(
      ledger.candidates.map((row) => [row.id, row.schemaVersion]).sort()
    ).toEqual(
      [
        [v1Id, 1],
        [v2Id, 2]
      ].sort()
    )
  })
})
