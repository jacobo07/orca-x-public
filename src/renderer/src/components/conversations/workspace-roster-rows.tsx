import { FileText } from 'lucide-react'

import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { formatUiRelativeTime } from '@/i18n/relative-time-format'
import type {
  WorkspaceAgentRow,
  WorkspaceProjectRef,
  WorkspaceThreadRow
} from '../../../../shared/cognitive-workspace-projection'

export function AgentMonogram({
  name,
  className
}: {
  name: string
  className?: string
}): React.JSX.Element {
  return (
    <span
      aria-hidden
      className={cn(
        'flex size-8 shrink-0 items-center justify-center rounded-full border border-border bg-background text-xs font-medium',
        className
      )}
    >
      {name.trim().charAt(0).toUpperCase() || '?'}
    </span>
  )
}

export function projectRefLabel(ref: WorkspaceProjectRef): string {
  switch (ref.kind) {
    case 'project':
      return ref.displayName
    case 'none':
      return translate('workspace.project.none', 'No project')
    case 'unresolved':
      return translate('workspace.project.unresolved', 'Project unavailable')
    case 'unknown':
      return translate('workspace.project.unknown', 'Project unknown')
  }
}

function relative(at: number): string {
  return formatUiRelativeTime(at - Date.now())
}

const rowClass =
  'flex w-full items-center gap-3 rounded-md px-2 py-2 text-left hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring aria-[current=true]:bg-accent'

export function WorkspaceAgentButton({
  row,
  active,
  onOpen
}: {
  row: WorkspaceAgentRow
  active: boolean
  onOpen: (agentId: string) => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={() => onOpen(row.agent.id)}
      aria-current={active ? 'true' : undefined}
      data-testid="workspace-agent-row"
      data-agent-id={row.agent.id}
      className={rowClass}
    >
      <AgentMonogram name={row.agent.name} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm">{row.agent.name}</span>
        <span className="block truncate text-xs text-muted-foreground">
          {[row.agent.role, projectRefLabel(row.project)].filter(Boolean).join(' · ')}
        </span>
      </span>
      {row.lastActivityAt !== null ? (
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {relative(row.lastActivityAt)}
        </span>
      ) : null}
    </button>
  )
}

/** Unreadable threads keep a row: dropping one would make a record on disk vanish unexplained. */
export function WorkspaceThreadButton({
  row,
  active,
  onOpen
}: {
  row: WorkspaceThreadRow
  active: boolean
  onOpen: (row: WorkspaceThreadRow) => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={() => onOpen(row)}
      aria-current={active ? 'true' : undefined}
      data-testid="conversations-list-row"
      data-conversation-id={row.id}
      className={rowClass}
    >
      <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 flex-1">
        {row.outcome === 'ok' ? (
          <>
            <span className="block truncate text-sm">
              {row.title ?? translate('conversations.untitled', 'Untitled')}
            </span>
            <span className="block truncate text-xs text-muted-foreground">
              {threadSubtitle(row)}
            </span>
          </>
        ) : row.outcome === 'unreadable' ? (
          <span className="block truncate text-sm text-destructive" title={row.reason}>
            {translate('conversations.rowUnreadable', 'Unreadable conversation')}
          </span>
        ) : (
          <span className="block truncate text-sm text-muted-foreground">
            {translate('conversations.rowTooNew', 'Saved by a newer Orca')}
          </span>
        )}
      </span>
      {row.outcome === 'ok' ? (
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {relative(row.updatedAt)}
        </span>
      ) : null}
    </button>
  )
}

function threadSubtitle(row: Extract<WorkspaceThreadRow, { outcome: 'ok' }>): string {
  const who =
    row.agent === null
      ? translate('workspace.thread.brainstorming', 'Brainstorming')
      : row.agent.kind === 'agent'
        ? row.agent.name
        : translate('workspace.thread.agentMissing', 'Agent unavailable')
  return row.agent === null ? who : `${who} · ${projectRefLabel(row.project)}`
}
