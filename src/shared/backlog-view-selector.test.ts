import { describe, expect, it } from 'vitest'

import type { BacklogItemSummary } from './backlog-summary'
import type { BacklogItemState, BacklogPriority, BacklogSourceKind } from './backlog-types'
import {
  BACKLOG_DEFAULT_VIEW_FILTERS,
  normalizeBacklogSearchText,
  selectBacklogView,
  type BacklogViewFilters
} from './backlog-view-selector'

type RowFields = {
  projects?: string[]
  state?: BacklogItemState
  priority?: BacklogPriority
  updatedAt?: number
  text?: string
  intent?: string
  sources?: BacklogSourceKind[]
  kind?: BacklogItemSummary['kind']
}

function row(id: string, fields: RowFields = {}): BacklogItemSummary {
  return {
    schemaVersion: 1,
    id,
    kind: fields.kind ?? 'engineering',
    originalText: fields.text ?? `text ${id}`,
    normalizedIntent: fields.intent ?? `intent ${id}`,
    projectRefs: (fields.projects ?? []).map((projectId) => ({
      projectId,
      mapping: 'explicit' as const,
      evidence: 'test'
    })),
    state: fields.state ?? 'needs-triage',
    priority: fields.priority ?? 'normal',
    dependencies: [],
    executorPolicy: null,
    sourceLinks: (fields.sources ?? []).map((kind) => ({
      kind,
      ref: `ref-${id}`,
      capturedAt: 1,
      candidateId: null
    })),
    executionLinks: [],
    mergedInto: null,
    revision: 1,
    createdAt: 1,
    updatedAt: fields.updatedAt ?? 1
  }
}

const filters = (patch: Partial<BacklogViewFilters> = {}): BacklogViewFilters => ({
  ...BACKLOG_DEFAULT_VIEW_FILTERS,
  ...patch
})

const A = row('A', { projects: ['P1'], updatedAt: 10 })
const B = row('B', { projects: ['P1', 'P2'], updatedAt: 40 })
const C = row('C', { updatedAt: 100, sources: ['manual'] })
const D = row('D', { projects: ['GONE'], updatedAt: 20 })
const E = row('E', { projects: ['P2'], updatedAt: 30, sources: ['codex-transcript'] })
const ROWS = [A, B, C, D, E]
const KNOWN = new Set(['P1', 'P2'])

const ids = (rows: readonly { id: string }[]) => rows.map((entry) => entry.id)

describe('selectBacklogView grouping and counts', () => {
  it('groups per project, unknown projects apart, Unassigned last even when newest', () => {
    const view = selectBacklogView(ROWS, filters(), KNOWN)
    expect(view.groups.map((group) => group.key)).toEqual([
      'project:P1',
      'project:P2',
      'unknown:GONE',
      'unassigned'
    ])
    expect(view.groups.map((group) => group.kind)).toEqual([
      'project',
      'project',
      'unknown',
      'unassigned'
    ])
    expect(view.groups.map((group) => group.count)).toEqual([2, 2, 1, 1])
    expect(view.groups[3]).toMatchObject({ projectId: null, latestUpdatedAt: 100 })
    expect(view.groups[2].projectId).toBe('GONE')
    const [p1, p2] = view.groups
    expect(p1.rows.find((entry) => entry.id === 'B')).toBe(B)
    expect(p2.rows.find((entry) => entry.id === 'B')).toBe(B)
  })

  it('counts a cross-project row once in All, the open total and the visible count', () => {
    const view = selectBacklogView(ROWS, filters(), KNOWN)
    expect(view.scopeCounts.all).toBe(5)
    expect(view.openTotal).toBe(5)
    expect(view.visibleCount).toBe(5)
    expect(view.openProjectCount).toBe(3)
    expect(view.scopeCounts.unassigned).toBe(1)
    expect(view.scopeCounts.projects.get('P1')).toBe(2)
    expect(view.scopeCounts.projects.get('P2')).toBe(2)
    expect(view.scopeCounts.projects.get('GONE')).toBe(1)
    expect(view.scopeCounts.sources.get('manual')).toBe(1)
    expect(view.filterEmpty).toBeNull()
  })

  it('groups hostile project ids correctly without polluting any prototype', () => {
    const hostile = [
      row('H1', { projects: ['__proto__'] }),
      row('H2', { projects: ['__proto__', 'constructor'] }),
      row('H3', { projects: ['constructor'] })
    ]
    const view = selectBacklogView(hostile, filters(), new Set(['__proto__', 'constructor']))
    const counts = Object.fromEntries(view.groups.map((group) => [group.key, group.count]))
    expect(view.groups).toHaveLength(2)
    expect(view.groups.find((group) => group.key === 'project:__proto__')?.count).toBe(2)
    expect(view.groups.find((group) => group.key === 'project:constructor')?.count).toBe(2)
    expect(Object.keys(counts).sort()).toEqual(['project:__proto__', 'project:constructor'])
    expect(view.scopeCounts.projects.get('__proto__')).toBe(2)
    expect(view.scopeCounts.all).toBe(3)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(Object.getPrototypeOf({})).toBe(Object.prototype)
    expect(typeof ({} as Record<string, unknown>).constructor).toBe('function')
  })
})

describe('selectBacklogView filters', () => {
  const mixed = [
    row('O', { state: 'ready', kind: 'idea' }),
    row('X', { state: 'done' }),
    row('Y', { state: 'dismissed' }),
    row('Z', { state: 'superseded' })
  ]

  it('hides closed states by default and shows all or one state on request', () => {
    expect(selectBacklogView(mixed, filters(), KNOWN).visibleCount).toBe(1)
    expect(selectBacklogView(mixed, filters({ state: 'all' }), KNOWN).visibleCount).toBe(4)
    const done = selectBacklogView(mixed, filters({ state: 'done' }), KNOWN)
    expect(ids(done.groups.flatMap((group) => group.rows))).toEqual(['X'])
  })

  it('filters by kind', () => {
    const view = selectBacklogView(mixed, filters({ state: 'all', kind: 'idea' }), KNOWN)
    expect(ids(view.groups.flatMap((group) => group.rows))).toEqual(['O'])
  })

  it('scopes to Unassigned, one project, or one source', () => {
    const visible = (scope: BacklogViewFilters['scope']) => {
      const view = selectBacklogView(ROWS, filters({ scope }), KNOWN)
      return [...new Set(ids(view.groups.flatMap((group) => group.rows)))].sort()
    }
    expect(visible({ kind: 'unassigned' })).toEqual(['C'])
    expect(visible({ kind: 'project', projectId: 'P2' })).toEqual(['B', 'E'])
    expect(visible({ kind: 'source', source: 'manual' })).toEqual(['C'])
  })

  it('computes scope chip counts under state, kind and text but not scope', () => {
    const rows = [...ROWS, row('F', { projects: ['P1'], state: 'done' })]
    const view = selectBacklogView(rows, filters({ scope: { kind: 'unassigned' } }), KNOWN)
    expect(view.visibleCount).toBe(1)
    expect(view.scopeCounts.all).toBe(5)
    expect(view.scopeCounts.projects.get('P1')).toBe(2)
    const texted = selectBacklogView(rows, filters({ text: 'intent B' }), KNOWN)
    expect(texted.scopeCounts.all).toBe(1)
    expect(texted.scopeCounts.projects.get('P2')).toBe(1)
    expect(texted.scopeCounts.projects.get('P1')).toBe(1)
    expect(texted.openTotal).toBe(5)
  })
})

describe('selectBacklogView search and sort', () => {
  it('searches case- and accent-insensitively, trimmed', () => {
    expect(normalizeBacklogSearchText('  CAFÉ ')).toBe('cafe')
    const rows = [row('A', { text: 'café au lait' }), row('B', { text: 'tea' })]
    const hit = selectBacklogView(rows, filters({ text: '  CAFE ' }), KNOWN)
    expect(ids(hit.groups.flatMap((group) => group.rows))).toEqual(['A'])
    const intent = selectBacklogView(rows, filters({ text: 'INTENT b' }), KNOWN)
    expect(ids(intent.groups.flatMap((group) => group.rows))).toEqual(['B'])
    expect(selectBacklogView(rows, filters({ text: '' }), KNOWN).visibleCount).toBe(2)
  })

  it('does not search beyond the first 2,000 characters of originalText', () => {
    const rows = [row('L', { text: `${'a'.repeat(2_000)}needle` })]
    expect(selectBacklogView(rows, filters({ text: 'needle' }), KNOWN).visibleCount).toBe(0)
  })

  it('sorts by updated desc, updated asc and priority, ties broken by id', () => {
    const rows = [
      row('b', { priority: 'low', updatedAt: 5 }),
      row('a', { priority: 'low', updatedAt: 5 }),
      row('c', { priority: 'urgent', updatedAt: 1 }),
      row('d', { priority: 'high', updatedAt: 9 }),
      row('e', { priority: 'normal', updatedAt: 7 }),
      row('f', { priority: 'normal', updatedAt: 8 })
    ]
    const order = (sort: BacklogViewFilters['sort']) =>
      ids(selectBacklogView(rows, filters({ sort }), KNOWN).groups[0].rows)
    expect(BACKLOG_DEFAULT_VIEW_FILTERS.sort).toBe('updated-desc')
    expect(order('updated-desc')).toEqual(['d', 'f', 'e', 'a', 'b', 'c'])
    expect(order('updated-asc')).toEqual(['c', 'a', 'b', 'e', 'f', 'd'])
    expect(order('priority')).toEqual(['c', 'd', 'f', 'e', 'a', 'b'])
  })
})

describe('selectBacklogView filterEmpty', () => {
  it('reports closed-only when only the Open filter hides every row', () => {
    const rows = [row('X', { state: 'done' }), row('Y', { state: 'dismissed' })]
    expect(selectBacklogView(rows, filters(), KNOWN).filterEmpty).toEqual({
      reason: 'closed-only',
      closedCount: 2
    })
  })

  it('reports filters otherwise', () => {
    const rows = [row('X', { state: 'done' }), row('Y', { state: 'ready' })]
    expect(
      selectBacklogView(rows, filters({ text: 'nothing matches' }), KNOWN).filterEmpty
    ).toEqual({ reason: 'filters', hiddenCount: 2 })
  })
})
