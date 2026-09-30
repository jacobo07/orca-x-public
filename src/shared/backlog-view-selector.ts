import { BACKLOG_SUMMARY_TEXT_MAX } from './backlog-rpc-limits'
import { isBacklogStateOpen, type BacklogItemSummary } from './backlog-summary'
import {
  BACKLOG_PRIORITIES,
  type BacklogItemKind,
  type BacklogItemState,
  type BacklogSourceKind
} from './backlog-types'

export type BacklogViewScope =
  | { kind: 'all' }
  | { kind: 'unassigned' }
  | { kind: 'project'; projectId: string }
  | { kind: 'source'; source: BacklogSourceKind }

export type BacklogViewSort = 'updated-desc' | 'updated-asc' | 'priority'

export type BacklogViewFilters = {
  scope: BacklogViewScope
  state: 'open' | 'all' | BacklogItemState
  kind: 'all' | BacklogItemKind
  text: string
  sort: BacklogViewSort
}

export const BACKLOG_DEFAULT_VIEW_FILTERS: BacklogViewFilters = {
  scope: { kind: 'all' },
  state: 'open',
  kind: 'all',
  text: '',
  sort: 'updated-desc'
}

export type BacklogViewGroup = {
  key: string
  kind: 'project' | 'unknown' | 'unassigned'
  projectId: string | null
  rows: readonly BacklogItemSummary[]
  count: number
  latestUpdatedAt: number
}

export type BacklogViewModel = {
  groups: readonly BacklogViewGroup[]
  scopeCounts: {
    all: number
    unassigned: number
    projects: ReadonlyMap<string, number>
    sources: ReadonlyMap<BacklogSourceKind, number>
  }
  openTotal: number
  openProjectCount: number
  visibleCount: number
  filterEmpty:
    | null
    | { reason: 'closed-only'; closedCount: number }
    | { reason: 'filters'; hiddenCount: number }
}

type Row = BacklogItemSummary

/** Locale-independent: NFD, combining marks stripped, lower-cased, trimmed. */
export function normalizeBacklogSearchText(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim()
}

function searchHaystack(row: Row): string {
  const text = row.originalText
  const prefix =
    text.length > BACKLOG_SUMMARY_TEXT_MAX
      ? Array.from(text).slice(0, BACKLOG_SUMMARY_TEXT_MAX).join('')
      : text
  return normalizeBacklogSearchText(`${row.normalizedIntent}\n${prefix}`)
}

function matchesState(row: Row, state: BacklogViewFilters['state']): boolean {
  return state === 'all'
    ? true
    : state === 'open'
      ? isBacklogStateOpen(row.state)
      : row.state === state
}

function matchesScope(row: Row, scope: BacklogViewScope): boolean {
  switch (scope.kind) {
    case 'all':
      return true
    case 'unassigned':
      return row.projectRefs.length === 0
    case 'project':
      return row.projectRefs.some((ref) => ref.projectId === scope.projectId)
    case 'source':
      return row.sourceLinks.some((link) => link.kind === scope.source)
  }
}

function distinct<T>(values: readonly T[]): T[] {
  return [...new Set(values)]
}

function projectIdsOf(row: Row): string[] {
  return distinct(row.projectRefs.map((ref) => ref.projectId))
}

function increment<K>(counts: Map<K, number>, key: K): void {
  counts.set(key, (counts.get(key) ?? 0) + 1)
}

const PRIORITY_RANK = new Map(BACKLOG_PRIORITIES.map((priority, index) => [priority, index]))

function byId(a: Row, b: Row): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

function comparator(sort: BacklogViewSort): (a: Row, b: Row) => number {
  const newest = (a: Row, b: Row) => b.updatedAt - a.updatedAt || byId(a, b)
  if (sort === 'updated-asc') {
    return (a, b) => a.updatedAt - b.updatedAt || byId(a, b)
  }
  if (sort === 'priority') {
    return (a, b) =>
      (PRIORITY_RANK.get(a.priority) ?? 0) - (PRIORITY_RANK.get(b.priority) ?? 0) || newest(a, b)
  }
  return newest
}

function scopeCountsOf(rows: readonly Row[]): BacklogViewModel['scopeCounts'] {
  const projects = new Map<string, number>()
  const sources = new Map<BacklogSourceKind, number>()
  let unassigned = 0
  for (const row of rows) {
    if (row.projectRefs.length === 0) {
      unassigned += 1
    }
    for (const projectId of projectIdsOf(row)) {
      increment(projects, projectId)
    }
    for (const source of distinct(row.sourceLinks.map((link) => link.kind))) {
      increment(sources, source)
    }
  }
  return { all: rows.length, unassigned, projects, sources }
}

type GroupDraft = Omit<BacklogViewGroup, 'rows' | 'count'> & { rows: Row[] }

function groupRows(
  rows: readonly Row[],
  scope: BacklogViewScope,
  knownProjectIds: ReadonlySet<string>,
  sort: BacklogViewSort
): BacklogViewGroup[] {
  const drafts = new Map<string, GroupDraft>()
  const place = (key: string, kind: GroupDraft['kind'], projectId: string | null, row: Row) => {
    const draft = drafts.get(key) ?? { key, kind, projectId, rows: [], latestUpdatedAt: 0 }
    draft.rows.push(row)
    draft.latestUpdatedAt = Math.max(draft.latestUpdatedAt, row.updatedAt)
    drafts.set(key, draft)
  }
  for (const row of rows) {
    const projectIds = projectIdsOf(row)
    if (projectIds.length === 0) {
      place('unassigned', 'unassigned', null, row)
    }
    for (const projectId of projectIds) {
      // A project scope shows only that project's group, not the row's other projects.
      if (scope.kind === 'project' && scope.projectId !== projectId) {
        continue
      }
      const known = knownProjectIds.has(projectId)
      place(
        `${known ? 'project' : 'unknown'}:${projectId}`,
        known ? 'project' : 'unknown',
        projectId,
        row
      )
    }
  }
  const compare = comparator(sort)
  const groups = [...drafts.values()].map((draft) => ({
    ...draft,
    rows: draft.rows.sort(compare),
    count: draft.rows.length
  }))
  return groups.sort((a, b) => {
    if ((a.kind === 'unassigned') !== (b.kind === 'unassigned')) {
      return a.kind === 'unassigned' ? 1 : -1
    }
    return b.latestUpdatedAt - a.latestUpdatedAt || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
  })
}

/**
 * Every number the Backlog page shows derives from here. Search covers normalizedIntent plus the
 * first 2,000 characters of originalText only (the summary row's bounded prefix).
 */
export function selectBacklogView(
  rows: readonly Row[],
  filters: BacklogViewFilters,
  knownProjectIds: ReadonlySet<string>
): BacklogViewModel {
  const seen = new Set<string>()
  const unique = rows.filter((row) => !seen.has(row.id) && seen.add(row.id))
  const query = normalizeBacklogSearchText(filters.text)
  const passesKindAndText = (row: Row) =>
    (filters.kind === 'all' || row.kind === filters.kind) &&
    (query === '' || searchHaystack(row).includes(query))
  const base = unique.filter((row) => matchesState(row, filters.state) && passesKindAndText(row))
  const visible = base.filter((row) => matchesScope(row, filters.scope))

  const open = unique.filter((row) => isBacklogStateOpen(row.state))
  const openProjects = new Set(open.flatMap((row) => projectIdsOf(row)))

  let filterEmpty: BacklogViewModel['filterEmpty'] = null
  if (visible.length === 0) {
    const closedCount =
      filters.state === 'open'
        ? unique.filter((row) => passesKindAndText(row) && matchesScope(row, filters.scope)).length
        : 0
    filterEmpty =
      closedCount > 0
        ? { reason: 'closed-only', closedCount }
        : { reason: 'filters', hiddenCount: unique.length }
  }

  return {
    groups: groupRows(visible, filters.scope, knownProjectIds, filters.sort),
    scopeCounts: scopeCountsOf(base),
    openTotal: open.length,
    openProjectCount: openProjects.size,
    visibleCount: visible.length,
    filterEmpty
  }
}
