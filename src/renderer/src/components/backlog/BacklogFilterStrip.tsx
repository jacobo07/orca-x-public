import { useMemo } from 'react'
import { CircleHelp, Inbox, Search } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { backlogSourceLabel } from '@/lib/backlog-source-labels'
import { Input } from '@/components/ui/input'
import { RepoBadgeMark } from '@/components/repo/RepoBadgeLabel'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import type { BacklogItemSummary } from '../../../../shared/backlog-summary'
import {
  BACKLOG_ITEM_KINDS,
  BACKLOG_ITEM_STATES,
  BACKLOG_SOURCE_KINDS
} from '../../../../shared/backlog-types'
import type {
  BacklogViewFilters,
  BacklogViewModel,
  BacklogViewScope,
  BacklogViewSort
} from '../../../../shared/backlog-view-selector'
import type { Project } from '../../../../shared/project-types'
import { backlogKindLabel, backlogStateLabel } from './backlog-presentation'
import { backlogItemCountLabel } from './BacklogGroupCard'
import { ClaimValue } from './ClaimValue'

const CHIP_CLASS =
  'h-8 min-w-0 gap-1.5 rounded-md border px-2 text-[12px] font-normal hover:bg-muted/40 hover:text-foreground data-[state=off]:border-border/40 data-[state=off]:text-muted-foreground data-[state=on]:border-foreground/40 data-[state=on]:bg-muted/70 data-[state=on]:text-foreground data-[state=on]:shadow-sm'
const TRIGGER_CLASS = 'h-8 text-[12px]'
const SORTS: readonly BacklogViewSort[] = ['updated-desc', 'updated-asc', 'priority']

type Chip = { key: string; name: string; count: number; mark: React.ReactNode }

function scopeKey(scope: BacklogViewScope): string {
  switch (scope.kind) {
    case 'all':
    case 'unassigned':
      return scope.kind
    case 'project':
      return `project:${scope.projectId}`
    case 'source':
      return `source:${scope.source}`
  }
}

function parseScope(key: string): BacklogViewScope | null {
  if (key === 'all' || key === 'unassigned') {
    return { kind: key }
  }
  if (key.startsWith('project:')) {
    return { kind: 'project', projectId: key.slice('project:'.length) }
  }
  const source = BACKLOG_SOURCE_KINDS.find((kind) => key === `source:${kind}`)
  return source ? { kind: 'source', source } : null
}

function sortLabel(sort: BacklogViewSort): string {
  switch (sort) {
    case 'updated-desc':
      return translate('backlog.sort.updatedDesc', 'Most recently updated')
    case 'updated-asc':
      return translate('backlog.sort.updatedAsc', 'Oldest first')
    case 'priority':
      return translate('backlog.sort.priority', 'Priority')
  }
}

// Project chips follow the group order: most recently updated project first.
function latestByProject(rows: readonly BacklogItemSummary[]): Map<string, number> {
  const latest = new Map<string, number>()
  for (const row of rows) {
    for (const ref of row.projectRefs) {
      latest.set(ref.projectId, Math.max(latest.get(ref.projectId) ?? 0, row.updatedAt))
    }
  }
  return latest
}

function buildChips(
  filters: BacklogViewFilters,
  counts: BacklogViewModel['scopeCounts'],
  projectsById: ReadonlyMap<string, Project>,
  latest: ReadonlyMap<string, number>
): Chip[] {
  const selected = filters.scope
  // A selected chip stays visible when its count drops to 0.
  const projectIds = new Set(counts.projects.keys())
  if (selected.kind === 'project') {
    projectIds.add(selected.projectId)
  }
  const ordered = [...projectIds].sort(
    (a, b) => (latest.get(b) ?? 0) - (latest.get(a) ?? 0) || (a < b ? -1 : a > b ? 1 : 0)
  )
  const projectChips = ordered.map((projectId): Chip => {
    const project = projectsById.get(projectId)
    return {
      key: `project:${projectId}`,
      name: project
        ? project.displayName
        : `${translate('backlog.group.unknown', 'Unknown project')} ${projectId}`,
      count: counts.projects.get(projectId) ?? 0,
      mark: project ? (
        <RepoBadgeMark color={project.badgeColor} className="size-2 rounded-full" />
      ) : (
        <CircleHelp className="size-3.5 text-muted-foreground" aria-hidden />
      )
    }
  })
  const sources = BACKLOG_SOURCE_KINDS.filter(
    (source) =>
      counts.sources.has(source) || (selected.kind === 'source' && selected.source === source)
  )
  return [
    { key: 'all', name: translate('backlog.filters.all', 'All'), count: counts.all, mark: null },
    ...projectChips,
    {
      key: 'unassigned',
      name: translate('backlog.group.unassigned', 'Unassigned'),
      count: counts.unassigned,
      mark: <Inbox className="size-3.5 text-muted-foreground" aria-hidden />
    },
    ...sources.map((source) => ({
      key: `source:${source}`,
      name: backlogSourceLabel(source),
      count: counts.sources.get(source) ?? 0,
      mark: null
    }))
  ]
}

function FilterSelect({
  handle,
  value,
  label,
  options,
  onValueChange
}: {
  handle: { 'data-backlog-filter'?: string; 'data-backlog-sort'?: string }
  value: string
  label: string
  options: readonly { value: string; label: string }[]
  onValueChange: (value: string) => void
}): React.JSX.Element {
  return (
    <Select value={value} onValueChange={onValueChange}>
      <SelectTrigger
        size="sm"
        className={TRIGGER_CLASS}
        data-value={value}
        aria-label={label}
        {...handle}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value} data-backlog-option={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function SearchField({
  value,
  onValueChange
}: {
  value: string
  onValueChange: (text: string) => void
}): React.JSX.Element {
  return (
    <div className="relative w-48">
      <Search
        className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
        aria-hidden
      />
      {value === '' ? (
        <span
          className="pointer-events-none absolute top-1/2 left-8 -translate-y-1/2 truncate text-[12px] text-muted-foreground/60"
          aria-hidden
        >
          {translate('backlog.filters.searchHint', 'Search text…')}
        </span>
      ) : null}
      <Input
        data-backlog-search=""
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            // Why: Esc inside the field clears it and never reaches a page-level handler.
            event.stopPropagation()
            onValueChange('')
            event.currentTarget.blur()
          }
        }}
        aria-label={translate('backlog.filters.search', 'Search backlog')}
        className="h-8 pl-8 text-[12px] md:text-[12px]"
      />
    </div>
  )
}

/** Scope chips, state / kind selects, search and sort. Every count comes from the page's one view model. */
export function BacklogFilterStrip({
  filters,
  onChange,
  scopeCounts,
  projectsById,
  rows
}: {
  filters: BacklogViewFilters
  onChange: (next: BacklogViewFilters) => void
  scopeCounts: BacklogViewModel['scopeCounts']
  projectsById: ReadonlyMap<string, Project>
  rows: readonly BacklogItemSummary[]
}): React.JSX.Element {
  const latest = useMemo(() => latestByProject(rows), [rows])
  const chips = buildChips(filters, scopeCounts, projectsById, latest)
  const stateOptions = [
    { value: 'open', label: translate('backlog.filters.stateOpen', 'Open') },
    { value: 'all', label: translate('backlog.filters.stateAll', 'All states') },
    ...BACKLOG_ITEM_STATES.map((state) => ({ value: state, label: backlogStateLabel(state) }))
  ]
  const kindOptions = [
    { value: 'all', label: translate('backlog.filters.kindAll', 'All kinds') },
    ...BACKLOG_ITEM_KINDS.map((kind) => ({ value: kind, label: backlogKindLabel(kind) }))
  ]
  return (
    <div className="flex flex-none flex-wrap items-center gap-2 pb-4">
      <ToggleGroup
        type="single"
        spacing={2}
        className="w-auto flex-wrap"
        value={scopeKey(filters.scope)}
        onValueChange={(key) => {
          const scope = parseScope(key)
          if (scope) {
            onChange({ ...filters, scope })
          }
        }}
        aria-label={translate('backlog.filters.scopeLabel', 'Filter by project')}
      >
        {chips.map((chip) => (
          <ToggleGroupItem
            key={chip.key}
            value={chip.key}
            data-backlog-scope={chip.key}
            data-count={chip.count}
            aria-label={translate('backlog.group.label', '{{project}}, {{items}}', {
              project: chip.name,
              items: backlogItemCountLabel(chip.count)
            })}
            className={CHIP_CLASS}
          >
            {chip.mark}
            <span className="max-w-40 truncate">{chip.name}</span>
            <ClaimValue testId="backlog-scope-count" value={chip.count} />
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      <FilterSelect
        handle={{ 'data-backlog-filter': 'state' }}
        value={filters.state}
        label={translate('backlog.filters.state', 'State')}
        options={stateOptions}
        onValueChange={(value) => {
          const state =
            value === 'open' || value === 'all'
              ? value
              : BACKLOG_ITEM_STATES.find((candidate) => candidate === value)
          if (state) {
            onChange({ ...filters, state })
          }
        }}
      />
      <FilterSelect
        handle={{ 'data-backlog-filter': 'kind' }}
        value={filters.kind}
        label={translate('backlog.filters.kind', 'Kind')}
        options={kindOptions}
        onValueChange={(value) => {
          const kind =
            value === 'all' ? value : BACKLOG_ITEM_KINDS.find((candidate) => candidate === value)
          if (kind) {
            onChange({ ...filters, kind })
          }
        }}
      />
      <SearchField value={filters.text} onValueChange={(text) => onChange({ ...filters, text })} />
      <FilterSelect
        handle={{ 'data-backlog-sort': '' }}
        value={filters.sort}
        label={translate('backlog.sort.label', 'Sort')}
        options={SORTS.map((sort) => ({ value: sort, label: sortLabel(sort) }))}
        onValueChange={(value) => {
          const sort = SORTS.find((candidate) => candidate === value)
          if (sort) {
            onChange({ ...filters, sort })
          }
        }}
      />
    </div>
  )
}
