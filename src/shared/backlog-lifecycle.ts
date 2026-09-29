import type { BacklogRefusalCode } from './backlog-outcomes'
import type {
  BacklogEvidence,
  BacklogEvidenceSubject,
  BacklogItem,
  BacklogItemState
} from './backlog-types'

// Edges into `done` are further guarded by checkBacklogCompletion. Same-state is never an edge: the
// fold answers it as `unchanged` without an event. Edges into `superseded` are merge-only.
export const BACKLOG_TRANSITIONS: Readonly<Record<BacklogItemState, readonly BacklogItemState[]>> =
  {
    'needs-triage': ['ready', 'blocked', 'dismissed', 'superseded', 'unknown', 'stale'],
    ready: [
      'waiting-for-executor',
      'preparing',
      'running',
      'blocked',
      'done',
      'dismissed',
      'superseded',
      'stale',
      'needs-triage'
    ],
    'waiting-for-executor': [
      'ready',
      'preparing',
      'running',
      'blocked',
      'dismissed',
      'superseded',
      'stale'
    ],
    preparing: ['ready', 'running', 'review', 'blocked', 'stale', 'dismissed', 'superseded'],
    running: ['review', 'done', 'ready', 'blocked', 'stale'],
    review: ['done', 'ready', 'blocked', 'superseded', 'stale'],
    done: ['ready'],
    blocked: ['ready', 'needs-triage', 'dismissed', 'superseded', 'stale'],
    stale: ['needs-triage', 'ready', 'dismissed', 'superseded'],
    unknown: ['needs-triage', 'dismissed'],
    dismissed: ['needs-triage'],
    superseded: []
  }

export function isBacklogTransitionLegal(from: BacklogItemState, to: BacklogItemState): boolean {
  return BACKLOG_TRANSITIONS[from].includes(to)
}

/** Edges into `superseded` belong to merge alone: it is the only path that sets `mergedInto`. */
export function canBacklogItemLoseMerge(state: BacklogItemState): boolean {
  return isBacklogTransitionLegal(state, 'superseded')
}

/** Model-origin rows never count, and neither do retracted, stale or merely inferred ones. */
export function countsAsCompletionEvidence(row: BacklogEvidence): boolean {
  return (row.class === 'PROVEN' || row.class === 'OBSERVED') && row.origin !== 'model'
}

export type BacklogCompletionCheck =
  | { ok: true }
  | {
      ok: false
      code: Extract<BacklogRefusalCode, 'idea-cannot-complete' | 'completion-evidence-missing'>
      detail: string
    }

type Requirement = { subject: BacklogEvidenceSubject; humanOnly: boolean }

const REQUIREMENTS: Record<Exclude<BacklogItem['kind'], 'idea'>, readonly Requirement[]> = {
  engineering: [
    { subject: 'revision', humanOnly: false },
    { subject: 'gate', humanOnly: false }
  ],
  research: [{ subject: 'artifact', humanOnly: false }],
  decision: [{ subject: 'human-resolution', humanOnly: true }],
  manual: [{ subject: 'confirmation', humanOnly: true }]
}

export function checkBacklogCompletion(item: BacklogItem): BacklogCompletionCheck {
  if (item.kind === 'idea') {
    return { ok: false, code: 'idea-cannot-complete', detail: 'an idea must be re-kinded first' }
  }
  const counted = item.evidence.filter(countsAsCompletionEvidence)
  for (const requirement of REQUIREMENTS[item.kind]) {
    const present = counted.some(
      (row) =>
        row.subject === requirement.subject && (!requirement.humanOnly || row.origin === 'human')
    )
    if (!present) {
      const who = requirement.humanOnly ? 'human-origin ' : ''
      return {
        ok: false,
        code: 'completion-evidence-missing',
        detail: `${item.kind} needs ${who}${requirement.subject} evidence`
      }
    }
  }
  return { ok: true }
}
