// SC3: assigning or clearing a candidate's project is an evented, open-only ledger write, and the
// only write that stamps schemaVersion 2 (R-01).

import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { BacklogCandidate, BacklogProjectHint } from '../../shared/backlog-types'
import type { BacklogCandidateResolution } from './backlog-candidate-resolution'
import { parseBacklogCandidate } from './backlog-candidate-validation'
import { BacklogService } from './backlog-service'

let root: string
let service: BacklogService

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-backlog-assign-'))
  service = new BacklogService(() => root, { now: () => 21 })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

async function ingest(fingerprint: string, projectHint?: BacklogProjectHint): Promise<string> {
  const [result] = await service.ingestCandidates([
    {
      source: {
        kind: 'orca-conversation',
        ref: 'conv_1',
        capturedAt: 1,
        adapter: 'orca-conversations',
        capabilityLevel: 'full'
      },
      fingerprint,
      text: `intent ${fingerprint}`,
      uncertainty: 'low',
      projectHint
    }
  ])
  if (result.outcome !== 'published' || result.id === null) {
    throw new Error(`precondition: ingest returned ${result.outcome}`)
  }
  return result.id
}

const pathOf = (id: string): string => join(root, 'candidates', `${id}.json`)
const onDisk = (id: string): BacklogCandidate =>
  JSON.parse(readFileSync(pathOf(id), 'utf-8')) as BacklogCandidate
const sha = (id: string): string =>
  createHash('sha256').update(readFileSync(pathOf(id))).digest('hex')

const ASSIGNED_P1 = { projectId: 'P1', evidence: 'assigned', mapping: 'explicit' }

describe('assign on an open candidate', () => {
  it('sets an explicit hint, stamps v2 and appends a hint-assigned event', async () => {
    const id = await ingest('fp-new')

    const outcome = await service.assignCandidate({ candidateId: id, projectId: 'P1' })

    expect(outcome.outcome).toBe('published')
    const stored = onDisk(id)
    expect(stored.projectHint).toEqual(ASSIGNED_P1)
    expect(stored.schemaVersion).toBe(2)
    expect(stored.revision).toBe(2)
    expect(stored.status).toBe('open')
    expect(stored.events.map((event) => event.type)).toEqual(['ingested', 'hint-assigned'])
    expect(stored.events[1].data).toEqual({ projectId: 'P1', previousProjectId: null })
  })

  it('records the previous project on a change and clears the hint with its own event', async () => {
    const id = await ingest('fp-change')
    await service.assignCandidate({ candidateId: id, projectId: 'P1' })

    await service.assignCandidate({ candidateId: id, projectId: 'P2' })
    expect(onDisk(id).events.at(-1)?.data).toEqual({ projectId: 'P2', previousProjectId: 'P1' })

    const cleared = await service.assignCandidate({ candidateId: id, projectId: null })
    expect(cleared.outcome).toBe('published')
    const stored = onDisk(id)
    expect(stored.projectHint).toBeNull()
    expect(stored.events.at(-1)?.data).toEqual({ projectId: null, previousProjectId: 'P2' })
    expect(stored.events).toHaveLength(4)

    const before = sha(id)
    const again = await service.assignCandidate({ candidateId: id, projectId: null })
    expect(again.outcome).toBe('unchanged')
    expect(onDisk(id).events).toHaveLength(4)
    expect(sha(id)).toBe(before)
  })

  it('answers unchanged for a repeated assignment and adds no event', async () => {
    const id = await ingest('fp-repeat')
    await service.assignCandidate({ candidateId: id, projectId: 'P1' })
    const before = sha(id)

    const again = await service.assignCandidate({ candidateId: id, projectId: 'P1' })

    expect(again.outcome).toBe('unchanged')
    expect(sha(id)).toBe(before)
  })

  it('leaving an unhinted candidate unassigned is unchanged', async () => {
    const id = await ingest('fp-none')
    const before = sha(id)

    expect((await service.assignCandidate({ candidateId: id, projectId: null })).outcome).toBe(
      'unchanged'
    )
    expect(sha(id)).toBe(before)
    expect(onDisk(id).schemaVersion).toBe(1)
  })

  it('confirming an inferred hint publishes: the mapping becomes explicit', async () => {
    const id = await ingest('fp-inferred', { projectId: 'P1', evidence: 'cwd' })

    const outcome = await service.assignCandidate({ candidateId: id, projectId: 'P1' })

    expect(outcome.outcome).toBe('published')
    expect(onDisk(id).projectHint).toEqual(ASSIGNED_P1)
    expect(onDisk(id).events.at(-1)?.data).toEqual({ projectId: 'P1', previousProjectId: 'P1' })
  })

  it('answers absent for a candidate that was never ingested', async () => {
    expect(
      await service.assignCandidate({ candidateId: `blc_${'0'.repeat(32)}`, projectId: 'P1' })
    ).toEqual({ outcome: 'absent' })
  })
})

describe('assign on a resolved candidate', () => {
  const RESOLUTIONS: [string, (candidateId: string) => BacklogCandidateResolution][] = [
    ['accepted', (candidateId) => ({ action: 'accept', candidateId })],
    ['merged', () => ({ action: 'merge', candidateId: '', itemId: '' })],
    ['already-done', (candidateId) => ({ action: 'already-done', candidateId })],
    ['superseded', (candidateId) => ({ action: 'superseded', candidateId })],
    ['dismissed', (candidateId) => ({ action: 'dismiss', candidateId })]
  ]

  it.each(RESOLUTIONS)('refuses %s and leaves the file bytes alone', async (status, resolve) => {
    const id = await ingest(`fp-${status}`)
    let resolution = resolve(id)
    if (resolution.action === 'merge') {
      const target = await service.capture({ text: 'merge target', kind: 'idea' })
      if (target.outcome !== 'published') {
        throw new Error(`precondition: capture returned ${target.outcome}`)
      }
      resolution = { action: 'merge', candidateId: id, itemId: target.record.id }
    }
    const resolved = await service.resolveCandidate(resolution)
    expect(resolved.candidate).toMatchObject({ outcome: 'published', record: { status } })
    const before = sha(id)

    const outcome = await service.assignCandidate({ candidateId: id, projectId: 'P1' })

    expect(outcome).toEqual({ outcome: 'refused', code: 'candidate-already-resolved', detail: null })
    expect(sha(id)).toBe(before)
  })

  it('positive control: the same assignment on an open candidate changes the file', async () => {
    const id = await ingest('fp-control')
    const before = sha(id)

    await service.assignCandidate({ candidateId: id, projectId: 'P1' })

    expect(sha(id)).not.toBe(before)
  })
})

describe('assign racing resolve', () => {
  it.each([
    ['assign first', true],
    ['resolve first', false]
  ])('%s: a hint never changes after resolution', async (_label, assignFirst) => {
    const id = await ingest(`fp-race-${String(assignFirst)}`)
    const assign = () => service.assignCandidate({ candidateId: id, projectId: 'P1' })
    const dismiss = () => service.resolveCandidate({ action: 'dismiss', candidateId: id })

    const results = await Promise.allSettled(
      assignFirst ? [assign(), dismiss()] : [dismiss(), assign()]
    )

    expect(results.every((result) => result.status === 'fulfilled')).toBe(true)
    const stored = onDisk(id)
    expect(stored.status).toBe('dismissed')
    const types = stored.events.map((event) => event.type)
    if (types.includes('hint-assigned')) {
      expect(types).toEqual(['ingested', 'hint-assigned', 'resolved'])
      expect(stored.projectHint).toEqual(ASSIGNED_P1)
    } else {
      expect(types).toEqual(['ingested', 'resolved'])
      expect(stored.projectHint).toBeNull()
    }
  })
})

describe('hint mapping validation', () => {
  async function withHint(hint: Record<string, unknown>) {
    const id = await ingest(`fp-validate-${String(hint.mapping)}`)
    return parseBacklogCandidate(JSON.stringify({ ...onDisk(id), projectHint: hint }), id)
  }

  it.each(['explicit', 'inferred', undefined])('accepts mapping %s', async (mapping) => {
    const hint = mapping === undefined ? { projectId: 'P', evidence: '' } : { projectId: 'P', evidence: '', mapping }
    expect((await withHint(hint)).outcome).toBe('loaded')
  })

  it('refuses an unknown mapping as invalid-field', async () => {
    expect(await withHint({ projectId: 'P', evidence: '', mapping: 'guessed' })).toMatchObject({
      outcome: 'unreadable',
      code: 'invalid-field'
    })
  })
})
