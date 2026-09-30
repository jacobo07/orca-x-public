import type {
  BacklogCandidateListQuery,
  BacklogCandidateListResult,
  BacklogHealthReport,
  BacklogListQuery,
  BacklogListResult
} from '../../shared/backlog-outcomes'
import { BACKLOG_LIST_LIMIT_DEFAULT } from '../../shared/backlog-rpc-limits'
import { isBacklogStateOpen, toBacklogItemSummary } from '../../shared/backlog-summary'
import {
  BACKLOG_CANDIDATE_STATUSES,
  BACKLOG_ITEM_KINDS,
  BACKLOG_ITEM_STATES,
  type BacklogCandidate,
  type BacklogItem
} from '../../shared/backlog-types'
import type { BacklogLedgerSnapshot } from './backlog-ledger-open'

type Page<R> = { page: R[]; total: number; nextCursor: string | null }

// The cursor is the decimal offset of the next page; params reject anything else.
function paginate<R>(rows: R[], limit: number | undefined, cursor: string | undefined): Page<R> {
  const size = limit ?? BACKLOG_LIST_LIMIT_DEFAULT
  const parsed = cursor === undefined ? 0 : Number.parseInt(cursor, 10)
  const offset = Number.isFinite(parsed) && parsed > 0 ? parsed : 0
  const end = offset + size
  return {
    page: rows.slice(offset, end),
    total: rows.length,
    nextCursor: end < rows.length ? String(end) : null
  }
}

function newestFirst(a: { at: number; id: string }, b: { at: number; id: string }): number {
  if (a.at !== b.at) {
    return b.at - a.at
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

function matchesItem(item: BacklogItem, query: BacklogListQuery): boolean {
  if (query.state !== undefined && item.state !== query.state) {
    return false
  }
  if (query.kind !== undefined && item.kind !== query.kind) {
    return false
  }
  if (
    query.projectId !== undefined &&
    !item.projectRefs.some((ref) => ref.projectId === query.projectId)
  ) {
    return false
  }
  return query.unassigned !== true || item.projectRefs.length === 0
}

function quarantinedCount(snapshot: BacklogLedgerSnapshot, kind: 'item' | 'candidate'): number {
  return snapshot.quarantined.filter((entry) => entry.recordKind === kind).length
}

export function queryBacklogItems(
  snapshot: BacklogLedgerSnapshot,
  query: BacklogListQuery
): BacklogListResult {
  const matches = snapshot.items
    .filter((item) => matchesItem(item, query))
    .sort((a, b) => newestFirst({ at: a.createdAt, id: a.id }, { at: b.createdAt, id: b.id }))
  const { page, total, nextCursor } = paginate(matches, query.limit, query.cursor)
  const rest = { total, nextCursor, quarantinedCount: quarantinedCount(snapshot, 'item') }
  // Projected after paging so the host never copies the whole ledger.
  return query.view === 'summary'
    ? {
        outcome: 'listed',
        view: 'summary',
        items: page.map((item) => toBacklogItemSummary(item)),
        ...rest
      }
    : { outcome: 'listed', view: 'full', items: page, ...rest }
}

export function queryBacklogCandidates(
  snapshot: BacklogLedgerSnapshot,
  query: BacklogCandidateListQuery
): BacklogCandidateListResult {
  const at = (row: BacklogCandidate) => ({ at: row.source.capturedAt, id: row.id })
  const matches = snapshot.candidates
    .filter((row) => query.status === undefined || row.status === query.status)
    .sort((a, b) => newestFirst(at(a), at(b)))
  const { page, total, nextCursor } = paginate(matches, query.limit, query.cursor)
  return {
    outcome: 'listed',
    candidates: page,
    total,
    nextCursor,
    quarantinedCount: quarantinedCount(snapshot, 'candidate')
  }
}

function countBy<K extends string>(keys: readonly K[], values: K[]): Record<K, number> {
  const counts = Object.fromEntries(keys.map((key) => [key, 0])) as Record<K, number>
  for (const value of values) {
    counts[value] = (counts[value] ?? 0) + 1
  }
  return counts
}

export function summarizeBacklogHealth(snapshot: BacklogLedgerSnapshot): BacklogHealthReport {
  const kinds = (items: BacklogItem[]) =>
    countBy(
      BACKLOG_ITEM_KINDS,
      items.map((item) => item.kind)
    )
  return {
    outcome: 'opened',
    items: {
      total: snapshot.items.length,
      byState: countBy(
        BACKLOG_ITEM_STATES,
        snapshot.items.map((item) => item.state)
      ),
      byKind: kinds(snapshot.items),
      openByKind: kinds(snapshot.items.filter((item) => isBacklogStateOpen(item.state)))
    },
    candidates: {
      total: snapshot.candidates.length,
      byStatus: countBy(
        BACKLOG_CANDIDATE_STATUSES,
        snapshot.candidates.map((row) => row.status)
      )
    },
    quarantined: snapshot.quarantined
  }
}
