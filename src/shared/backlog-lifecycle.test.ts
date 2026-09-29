import { describe, expect, it } from 'vitest'

import {
  BACKLOG_TRANSITIONS,
  checkBacklogCompletion,
  countsAsCompletionEvidence,
  isBacklogTransitionLegal
} from './backlog-lifecycle'
import {
  BACKLOG_ITEM_STATES,
  type BacklogEvidence,
  type BacklogItem,
  type BacklogItemKind
} from './backlog-types'

function row(overrides: Partial<BacklogEvidence>): BacklogEvidence {
  return {
    id: 'blv_00000000-0000-4000-8000-000000000001',
    class: 'OBSERVED',
    origin: 'tool',
    subject: 'other',
    source: 'test',
    ref: null,
    observedAt: 1,
    ...overrides
  }
}

function item(kind: BacklogItemKind, evidence: BacklogEvidence[]): BacklogItem {
  return {
    schemaVersion: 1,
    id: 'bli_00000000-0000-4000-8000-000000000000',
    kind,
    originalText: 'x',
    normalizedIntent: 'x',
    projectRefs: [],
    state: 'ready',
    priority: 'normal',
    dependencies: [],
    executorPolicy: null,
    sourceLinks: [],
    executionLinks: [],
    evidence,
    events: [],
    mergedInto: null,
    revision: 1,
    createdAt: 1,
    updatedAt: 1
  }
}

describe('BACKLOG_TRANSITIONS', () => {
  it('covers every state, never self-loops, and has exactly 52 edges', () => {
    expect(Object.keys(BACKLOG_TRANSITIONS).sort()).toEqual([...BACKLOG_ITEM_STATES].sort())
    let edges = 0
    for (const state of BACKLOG_ITEM_STATES) {
      expect(BACKLOG_TRANSITIONS[state]).not.toContain(state)
      edges += BACKLOG_TRANSITIONS[state].length
    }
    expect(edges).toBe(52)
    expect(BACKLOG_TRANSITIONS.superseded).toEqual([])
    expect(BACKLOG_TRANSITIONS.done).toEqual(['ready'])
  })

  it('answers legality from the table', () => {
    expect(isBacklogTransitionLegal('ready', 'done')).toBe(true)
    expect(isBacklogTransitionLegal('superseded', 'ready')).toBe(false)
    expect(isBacklogTransitionLegal('unknown', 'ready')).toBe(false)
    expect(isBacklogTransitionLegal('ready', 'ready')).toBe(false)
  })
})

describe('completion evidence', () => {
  it('counts only non-model PROVEN or OBSERVED rows', () => {
    expect(countsAsCompletionEvidence(row({ class: 'PROVEN', origin: 'human' }))).toBe(true)
    expect(countsAsCompletionEvidence(row({ class: 'OBSERVED', origin: 'tool' }))).toBe(true)
    expect(countsAsCompletionEvidence(row({ class: 'OBSERVED', origin: 'model' }))).toBe(false)
    for (const cls of ['RETRACTED', 'STALE', 'INFERRED', 'HYPOTHESIZED', 'UNKNOWN'] as const) {
      expect(countsAsCompletionEvidence(row({ class: cls })), cls).toBe(false)
    }
  })

  it('engineering needs a revision row AND a gate row', () => {
    const revision = row({ subject: 'revision' })
    const gate = row({ subject: 'gate' })
    expect(checkBacklogCompletion(item('engineering', [revision]))).toMatchObject({
      ok: false,
      code: 'completion-evidence-missing'
    })
    expect(checkBacklogCompletion(item('engineering', [revision, gate]))).toEqual({ ok: true })
  })

  it('a model-origin or retracted gate row does not count', () => {
    const revision = row({ subject: 'revision' })
    for (const gate of [
      row({ subject: 'gate', origin: 'model' }),
      row({ subject: 'gate', class: 'RETRACTED' }),
      row({ subject: 'gate', class: 'STALE' }),
      row({ subject: 'gate', class: 'INFERRED' })
    ]) {
      expect(checkBacklogCompletion(item('engineering', [revision, gate])).ok).toBe(false)
    }
  })

  it('research needs an artifact row', () => {
    expect(checkBacklogCompletion(item('research', [])).ok).toBe(false)
    expect(checkBacklogCompletion(item('research', [row({ subject: 'artifact' })]))).toEqual({
      ok: true
    })
  })

  it('decision needs a human-origin human-resolution row', () => {
    const toolRow = row({ subject: 'human-resolution', origin: 'tool' })
    const humanRow = row({ subject: 'human-resolution', origin: 'human' })
    expect(checkBacklogCompletion(item('decision', [toolRow])).ok).toBe(false)
    expect(checkBacklogCompletion(item('decision', [humanRow]))).toEqual({ ok: true })
  })

  it('manual needs a human-origin confirmation row', () => {
    const toolRow = row({ subject: 'confirmation', origin: 'tool' })
    const humanRow = row({ subject: 'confirmation', origin: 'human' })
    expect(checkBacklogCompletion(item('manual', [toolRow])).ok).toBe(false)
    expect(checkBacklogCompletion(item('manual', [humanRow]))).toEqual({ ok: true })
  })

  it('idea can never complete, whatever the evidence', () => {
    const all = (['revision', 'gate', 'artifact', 'human-resolution', 'confirmation'] as const).map(
      (subject) => row({ subject, origin: 'human', class: 'PROVEN' })
    )
    expect(checkBacklogCompletion(item('idea', all))).toMatchObject({
      ok: false,
      code: 'idea-cannot-complete'
    })
  })
})
