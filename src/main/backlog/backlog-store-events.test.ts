// SC4: every legal transition appends exactly one event; every illegal one is refused with the
// bytes on disk unchanged. Items are seeded as fixture JSON so every from-state is reachable.

import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { BACKLOG_TRANSITIONS } from '../../shared/backlog-lifecycle'
import {
  BACKLOG_ITEM_STATES,
  type BacklogEvidence,
  type BacklogItem,
  type BacklogItemKind,
  type BacklogItemState
} from '../../shared/backlog-types'
import { mintBacklogEventId, mintBacklogItemId } from './backlog-identity-mint'
import { BacklogService } from './backlog-service'

let root: string
let service: BacklogService

const evidenceRow = (subject: BacklogEvidence['subject'], n: number): BacklogEvidence => ({
  id: `blv_00000000-0000-4000-8000-00000000000${n}`,
  class: 'OBSERVED',
  origin: 'tool',
  subject,
  source: 'fixture',
  ref: null,
  observedAt: 1
})

function seed(
  state: BacklogItemState,
  kind: BacklogItemKind = 'engineering',
  evidence: BacklogEvidence[] = [evidenceRow('revision', 1), evidenceRow('gate', 2)]
): BacklogItem {
  const id = mintBacklogItemId()
  const item: BacklogItem = {
    schemaVersion: 1,
    id,
    kind,
    originalText: `seeded ${state}`,
    normalizedIntent: `seeded ${state}`,
    projectRefs: [],
    state,
    priority: 'normal',
    dependencies: [],
    executorPolicy: null,
    sourceLinks: [{ kind: 'manual', ref: id, capturedAt: 1, candidateId: null }],
    executionLinks: [],
    evidence,
    events: [{ id: mintBacklogEventId(), type: 'created', at: 1, data: { origin: 'manual' } }],
    // Only a merge produces superseded, and it always names the survivor.
    mergedInto: state === 'superseded' ? mintBacklogItemId() : null,
    revision: 1,
    createdAt: 1,
    updatedAt: 1
  }
  writeFileSync(pathOf(id), `${JSON.stringify(item, null, 2)}\n`)
  return item
}

const pathOf = (id: string): string => join(root, 'items', `${id}.json`)
const sha = (id: string): string =>
  createHash('sha256').update(readFileSync(pathOf(id))).digest('hex')

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-backlog-events-'))
  mkdirSync(join(root, 'items'))
  service = new BacklogService(() => root, { now: () => 42 })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('transition', () => {
  // 52 table edges minus the 7 into `superseded`, which only a merge may take (WR-02).
  it('appends exactly one transitioned event on every legal edge', async () => {
    let legal = 0
    for (const from of BACKLOG_ITEM_STATES) {
      for (const to of BACKLOG_TRANSITIONS[from]) {
        if (to === 'superseded') {
          continue
        }
        const item = seed(from)
        const outcome = await service.transition(item.id, { to })
        if (outcome.outcome !== 'published') {
          throw new Error(`${from}->${to} returned ${JSON.stringify(outcome)}`)
        }
        expect(outcome.record.state).toBe(to)
        expect(outcome.record.revision).toBe(2)
        expect(outcome.record.events).toHaveLength(2)
        expect(outcome.record.events[1]).toMatchObject({
          type: 'transitioned',
          at: 42,
          data: { from, to, reason: null }
        })
        legal += 1
      }
    }
    expect(legal).toBe(45)
  })

  it('refuses every table edge into superseded as use-merge with the bytes unchanged', async () => {
    let refused = 0
    for (const from of BACKLOG_ITEM_STATES) {
      if (!BACKLOG_TRANSITIONS[from].includes('superseded')) {
        continue
      }
      const item = seed(from)
      const before = sha(item.id)
      const outcome = await service.transition(item.id, { to: 'superseded' })
      expect(outcome, from).toMatchObject({ outcome: 'refused', code: 'use-merge' })
      expect(sha(item.id)).toBe(before)
      refused += 1
    }
    expect(refused).toBe(7)
  })

  it('reads superseded without mergedInto, or mergedInto without superseded, as invalid', async () => {
    const orphan = seed('superseded')
    writeFileSync(
      pathOf(orphan.id),
      `${JSON.stringify({ ...orphan, mergedInto: null }, null, 2)}\n`
    )
    expect(await service.get(orphan.id)).toMatchObject({ outcome: 'unreadable', code: 'invalid-field' })
    const pointing = seed('ready')
    writeFileSync(
      pathOf(pointing.id),
      `${JSON.stringify({ ...pointing, mergedInto: mintBacklogItemId() }, null, 2)}\n`
    )
    expect(await service.get(pointing.id)).toMatchObject({
      outcome: 'unreadable',
      code: 'invalid-field'
    })
    // Control: the well-formed superseded shape still loads.
    expect(await service.get(seed('superseded').id)).toMatchObject({ outcome: 'loaded' })
  })

  it('refuses every illegal ordered pair with the bytes unchanged', async () => {
    let illegal = 0
    for (const from of BACKLOG_ITEM_STATES) {
      for (const to of BACKLOG_ITEM_STATES) {
        if (from === to || BACKLOG_TRANSITIONS[from].includes(to)) {
          continue
        }
        const item = seed(from)
        const before = sha(item.id)
        const outcome = await service.transition(item.id, { to })
        expect(outcome, `${from}->${to}`).toMatchObject({
          outcome: 'refused',
          code: 'illegal-transition',
          detail: `${from}->${to}`
        })
        expect(sha(item.id)).toBe(before)
        illegal += 1
      }
    }
    expect(illegal).toBe(80)
  })

  it('answers a same-state transition as unchanged with no event', async () => {
    const item = seed('ready')
    const before = sha(item.id)
    const outcome = await service.transition(item.id, { to: 'ready' })
    expect(outcome.outcome).toBe('unchanged')
    expect(sha(item.id)).toBe(before)
  })

  it('refuses done without the kind’s completion evidence, and for an idea at all', async () => {
    const bare = seed('ready', 'engineering', [])
    expect(await service.transition(bare.id, { to: 'done' })).toMatchObject({
      outcome: 'refused',
      code: 'completion-evidence-missing'
    })
    const idea = seed('ready', 'idea')
    expect(await service.transition(idea.id, { to: 'done' })).toMatchObject({
      outcome: 'refused',
      code: 'idea-cannot-complete'
    })
  })

  it('records the reason when one is given', async () => {
    const item = seed('needs-triage')
    const outcome = await service.transition(item.id, { to: 'blocked', reason: 'waiting on API' })
    expect(outcome).toMatchObject({ outcome: 'published' })
    expect((outcome as { record: BacklogItem }).record.events[1].data).toEqual({
      from: 'needs-triage',
      to: 'blocked',
      reason: 'waiting on API'
    })
  })
})

describe('update', () => {
  it('appends ONE updated event naming every changed field', async () => {
    const item = seed('ready')
    const outcome = await service.update(item.id, { priority: 'urgent', normalizedIntent: 'sharper' })
    if (outcome.outcome !== 'published') {
      throw new Error(`update returned ${JSON.stringify(outcome)}`)
    }
    expect(outcome.record.events).toHaveLength(2)
    expect(outcome.record.events[1]).toMatchObject({
      type: 'updated',
      data: { fields: ['normalizedIntent', 'priority'] }
    })
    expect(outcome.record.updatedAt).toBe(42)
  })

  it('answers an update that changes nothing as unchanged', async () => {
    const item = seed('ready')
    const before = sha(item.id)
    expect((await service.update(item.id, { priority: 'normal' })).outcome).toBe('unchanged')
    expect(sha(item.id)).toBe(before)
  })

  it('stamps ids on added evidence and skips execution links already present', async () => {
    const item = seed('ready')
    const first = await service.update(item.id, {
      addExecutionLinks: [{ kind: 'github-issue', ref: '#1' }],
      addEvidence: [{ class: 'OBSERVED', origin: 'tool', subject: 'artifact', source: 'ci', ref: null }]
    })
    expect(first.outcome).toBe('published')
    const again = await service.update(item.id, {
      addExecutionLinks: [{ kind: 'github-issue', ref: '#1' }]
    })
    expect(again.outcome).toBe('unchanged')
    const record = (first as { record: BacklogItem }).record
    expect(record.evidence).toHaveLength(3)
    expect(record.evidence[2].id).toMatch(/^blv_/)
    expect(record.evidence[2].observedAt).toBe(42)
  })

  it.each([
    ['model-evidence-proven', 'ready', {
      addEvidence: [{ class: 'PROVEN', origin: 'model', subject: 'gate', source: 'llm', ref: null }]
    }],
    ['kind-change-while-done', 'done', { kind: 'research' }],
    ['self-dependency', 'ready', 'SELF']
  ] as const)('refuses %s with the bytes unchanged', async (code, state, patch) => {
    const item = seed(state)
    const before = sha(item.id)
    const actual = patch === 'SELF' ? { dependencies: [item.id] } : patch
    const outcome = await service.update(item.id, actual as never)
    expect(outcome).toMatchObject({ outcome: 'refused', code })
    expect(sha(item.id)).toBe(before)
  })

  it.each([
    ['an execution link', { addExecutionLinks: [{ kind: 'github-issue', ref: '#9' }] }],
    ['evidence', { addEvidence: [{ class: 'OBSERVED', origin: 'tool', subject: 'gate', source: 'ci', ref: null }] }],
    ['a field', { priority: 'urgent' }]
  ] as const)('refuses %s on a superseded item, naming the survivor', async (_label, patch) => {
    const item = seed('superseded')
    const before = sha(item.id)
    const outcome = await service.update(item.id, patch as never)
    expect(outcome).toEqual({
      outcome: 'refused',
      code: 'merge-target-superseded',
      detail: item.mergedInto
    })
    expect(sha(item.id)).toBe(before)
  })
})
