import { describe, expect, it } from 'vitest'

import type { BacklogQuarantineEntry } from '../../shared/backlog-outcomes'
import {
  BACKLOG_CANDIDATE_STATUSES,
  BACKLOG_ITEM_STATES,
  type BacklogCandidate,
  type BacklogCandidateStatus,
  type BacklogItem,
  type BacklogItemKind,
  type BacklogItemState
} from '../../shared/backlog-types'
import type { BacklogLedgerSnapshot } from './backlog-ledger-open'
import {
  queryBacklogCandidates,
  queryBacklogItems,
  summarizeBacklogHealth
} from './backlog-ledger-queries'

function itemId(n: number): string {
  return `bli_00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
}

function item(
  n: number,
  fields: { state?: BacklogItemState; kind?: BacklogItemKind; project?: string; createdAt?: number }
): BacklogItem {
  return {
    schemaVersion: 1,
    id: itemId(n),
    kind: fields.kind ?? 'engineering',
    originalText: `item ${n}`,
    normalizedIntent: `item ${n}`,
    projectRefs: fields.project
      ? [{ projectId: fields.project, mapping: 'explicit', evidence: 'test' }]
      : [],
    state: fields.state ?? 'needs-triage',
    priority: 'normal',
    dependencies: [],
    executorPolicy: null,
    sourceLinks: [],
    executionLinks: [],
    evidence: [],
    events: [],
    mergedInto: null,
    revision: 1,
    createdAt: fields.createdAt ?? n,
    updatedAt: fields.createdAt ?? n
  }
}

function candidate(n: number, status: BacklogCandidateStatus): BacklogCandidate {
  return {
    schemaVersion: 1,
    id: `blc_${n.toString(16).padStart(32, '0')}`,
    fingerprint: `fp-${n}`,
    source: {
      kind: 'orca-conversation',
      ref: `conv_${n}`,
      capturedAt: n,
      adapter: 'orca-conversations',
      capabilityLevel: 'full'
    },
    text: `candidate ${n}`,
    uncertainty: 'unknown',
    status,
    resolvedItemId: null,
    projectHint: null,
    events: [],
    revision: 1
  }
}

const QUARANTINED: BacklogQuarantineEntry = {
  recordKind: 'item',
  fileName: 'garbage.json',
  id: null,
  code: 'invalid-name',
  reason: 'file name is not a record id'
}

const SNAPSHOT: BacklogLedgerSnapshot = {
  outcome: 'opened',
  items: [
    item(1, { state: 'ready', project: 'P', createdAt: 10 }),
    item(2, { state: 'needs-triage', kind: 'idea', createdAt: 30 }),
    item(3, { state: 'ready', project: 'Q', createdAt: 20 }),
    item(4, { state: 'done', project: 'P', createdAt: 30 }),
    item(5, { state: 'ready', createdAt: 5 })
  ],
  candidates: [candidate(1, 'open'), candidate(2, 'dismissed'), candidate(3, 'open')],
  quarantined: [QUARANTINED]
}

const ids = (rows: { id: string }[]) => rows.map((row) => row.id)

describe('ledger item queries', () => {
  it('sorts createdAt descending, then id ascending, and counts the quarantine', () => {
    const listed = queryBacklogItems(SNAPSHOT, {})
    expect(listed).toMatchObject({ outcome: 'listed', total: 5, nextCursor: null, quarantinedCount: 1 })
    expect(listed.outcome === 'listed' && ids(listed.items)).toEqual([
      itemId(2),
      itemId(4),
      itemId(3),
      itemId(1),
      itemId(5)
    ])
  })

  it('filters by state, kind, project and Unassigned', () => {
    const only = (query: Parameters<typeof queryBacklogItems>[1]) => {
      const listed = queryBacklogItems(SNAPSHOT, query)
      return listed.outcome === 'listed' ? { total: listed.total, ids: ids(listed.items) } : null
    }
    expect(only({ state: 'ready' })).toEqual({ total: 3, ids: [itemId(3), itemId(1), itemId(5)] })
    expect(only({ kind: 'idea' })).toEqual({ total: 1, ids: [itemId(2)] })
    expect(only({ projectId: 'P' })).toEqual({ total: 2, ids: [itemId(4), itemId(1)] })
    expect(only({ unassigned: true })).toEqual({ total: 2, ids: [itemId(2), itemId(5)] })
    expect(only({ state: 'ready', unassigned: true })).toEqual({ total: 1, ids: [itemId(5)] })
  })

  it('pages with a decimal cursor; total counts every match', () => {
    const first = queryBacklogItems(SNAPSHOT, { limit: 2 })
    if (first.outcome !== 'listed') {
      throw new Error(first.outcome)
    }
    expect(first.total).toBe(5)
    expect(ids(first.items)).toEqual([itemId(2), itemId(4)])
    expect(first.nextCursor).toBe('2')

    const second = queryBacklogItems(SNAPSHOT, { limit: 2, cursor: first.nextCursor! })
    const third = queryBacklogItems(SNAPSHOT, {
      limit: 2,
      cursor: (second as { nextCursor: string }).nextCursor
    })
    expect(second.outcome === 'listed' && ids(second.items)).toEqual([itemId(3), itemId(1)])
    expect(third).toMatchObject({ total: 5, nextCursor: null })
    expect(third.outcome === 'listed' && ids(third.items)).toEqual([itemId(5)])
  })
})

describe('ledger candidate queries and health', () => {
  it('filters candidates by status', () => {
    const open = queryBacklogCandidates(SNAPSHOT, { status: 'open' })
    expect(open).toMatchObject({ outcome: 'listed', total: 2, nextCursor: null })
    expect(open.outcome === 'listed' && open.candidates.every((row) => row.status === 'open')).toBe(
      true
    )
    expect(queryBacklogCandidates(SNAPSHOT, {})).toMatchObject({ total: 3 })
  })

  it('reports every state and status key, zero included, and the quarantine', () => {
    const health = summarizeBacklogHealth(SNAPSHOT)
    expect(Object.keys(health.items.byState).sort()).toEqual([...BACKLOG_ITEM_STATES].sort())
    expect(Object.keys(health.candidates.byStatus).sort()).toEqual(
      [...BACKLOG_CANDIDATE_STATUSES].sort()
    )
    expect(health.items).toMatchObject({ total: 5, byState: { ready: 3, done: 1, running: 0 } })
    expect(health.candidates).toMatchObject({ total: 3, byStatus: { open: 2, dismissed: 1, merged: 0 } })
    expect(health.quarantined).toEqual([QUARANTINED])
  })
})
