import { useState } from 'react'
import { ChevronDown, CircleHelp, Inbox } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { formatUiRelativeTime } from '@/i18n/relative-time-format'
import { cn } from '@/lib/utils'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { RepoBadgeMark } from '@/components/repo/RepoBadgeLabel'
import type { BacklogViewGroup } from '../../../../shared/backlog-view-selector'
import type { Project } from '../../../../shared/project-types'
import { BacklogRow } from './BacklogRow'
import { ClaimValue } from './ClaimValue'

/** "{{count}} item(s)" for accessible names; the visible count is a ClaimValue plus the noun. */
export function backlogItemCountLabel(count: number): string {
  return count === 1
    ? translate('backlog.group.items_one', '{{count}} item', { count })
    : translate('backlog.group.items_other', '{{count}} items', { count })
}

function groupName(group: BacklogViewGroup, project: Project | undefined): string {
  if (group.kind === 'unassigned') {
    return translate('backlog.group.unassigned', 'Unassigned')
  }
  if (group.kind === 'unknown' || !project) {
    return translate('backlog.group.unknown', 'Unknown project')
  }
  return project.displayName
}

function GroupMark({
  group,
  project
}: {
  group: BacklogViewGroup
  project: Project | undefined
}): React.JSX.Element {
  if (group.kind === 'unassigned') {
    return <Inbox className="size-4 shrink-0 text-muted-foreground" aria-hidden />
  }
  if (group.kind === 'unknown' || !project) {
    return <CircleHelp className="size-4 shrink-0 text-[var(--status-unknown)]" aria-hidden />
  }
  return <RepoBadgeMark color={project.badgeColor} className="size-2 rounded-full" />
}

export function BacklogGroupCard({
  group,
  project
}: {
  group: BacklogViewGroup
  project: Project | undefined
}): React.JSX.Element {
  const [open, setOpen] = useState(true)
  const name = groupName(group, project)
  const count = backlogItemCountLabel(group.count)
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      data-backlog-group={group.key}
      data-count={group.count}
      className="rounded-xl border border-border bg-card"
    >
      <CollapsibleTrigger
        data-backlog-group-toggle=""
        aria-label={translate('backlog.group.label', '{{project}}, {{items}}', {
          project: group.kind === 'unknown' ? `${name} ${group.projectId ?? ''}` : name,
          items: count
        })}
        className="flex w-full items-center gap-2 rounded-xl px-4 py-2 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronDown
          className={cn(
            'size-4 shrink-0 text-muted-foreground motion-safe:transition-transform',
            !open && '-rotate-90'
          )}
          aria-hidden
        />
        <GroupMark group={group} project={project} />
        <span className="min-w-0 truncate text-sm font-medium">{name}</span>
        {group.kind === 'unknown' && group.projectId ? (
          <span
            className="min-w-0 truncate font-mono text-xs text-muted-foreground"
            title={group.projectId}
          >
            {group.projectId}
          </span>
        ) : null}
        <span className="flex-1" />
        <span className="shrink-0 text-xs text-muted-foreground">
          {formatUiRelativeTime(group.latestUpdatedAt - Date.now())}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">
          <ClaimValue testId="backlog-group-count" value={group.count} />{' '}
          {group.count === 1
            ? translate('backlog.group.noun_one', 'item')
            : translate('backlog.group.noun_other', 'items')}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        {group.rows.map((row) => (
          <BacklogRow key={row.id} row={row} />
        ))}
      </CollapsibleContent>
    </Collapsible>
  )
}
