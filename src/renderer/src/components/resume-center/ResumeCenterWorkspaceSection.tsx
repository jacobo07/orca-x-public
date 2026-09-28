import { useState } from 'react'
import { ChevronDown, ChevronUp, FolderGit2 } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { formatUiRelativeTime } from '@/i18n/relative-time-format'
import { Button } from '@/components/ui/button'
import {
  activateAndRevealFolderWorkspace,
  activateAndRevealWorktree
} from '@/lib/worktree-activation'
import { getExecutionHostLabel } from '../../../../shared/execution-host'
import type { WorkspaceRowModel } from './resume-center-model'
import { describeWindow, describeWorkspaceName } from './resume-center-presentation'
import { ClaimValue } from './ClaimValue'
import { PanePreviewThumb } from './PanePreviewThumb'
import { ResumeCenterTabRow } from './ResumeCenterTabRow'

function openWorkspace(row: WorkspaceRowModel): void {
  if (row.key.startsWith('folder:')) {
    activateAndRevealFolderWorkspace(row.key.slice('folder:'.length), {
      executionHostId: row.hostId
    })
    return
  }
  const worktreeId = row.key.startsWith('worktree:') ? row.key.slice('worktree:'.length) : row.key
  activateAndRevealWorktree(worktreeId, { executionHostId: row.hostId })
}

export function ResumeCenterWorkspaceSection({
  row
}: {
  row: WorkspaceRowModel
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(true)
  const firstTab = row.tabs[0]
  const firstPane = firstTab?.panes[0]
  const name = describeWorkspaceName(row.identity, row.key)
  const path = row.identity.kind === 'known' ? row.identity.path : null
  return (
    <section
      data-testid="resume-center-workspace"
      data-workspace-key={row.key}
      aria-label={name}
      className="rounded-lg border border-border bg-card/40"
    >
      <header className="flex items-start gap-3 px-4 py-3">
        <FolderGit2 className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-medium">{name}</h3>
          {path ? (
            <p className="truncate font-mono text-[11px] text-muted-foreground">{path}</p>
          ) : null}
          <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
            <span className="rounded-full border border-border px-2 py-0.5">
              {describeWindow(row.window, row.windowOrder)}
            </span>
            {row.hostId !== 'local' ? (
              <span className="rounded-full border border-border px-2 py-0.5">
                {getExecutionHostLabel(row.hostId)}
              </span>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-3 text-[11px] text-muted-foreground">
          {row.lastVisitedAt !== null ? (
            <span>{formatUiRelativeTime(row.lastVisitedAt - Date.now())}</span>
          ) : null}
          <span>
            <ClaimValue testId="resume-center-workspace-session-count">
              {row.counts.tabs}
            </ClaimValue>{' '}
            {translate('resumeCenter.workspace.sessions', 'sessions')}
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={row.identity.kind === 'missing'}
            onClick={() => openWorkspace(row)}
          >
            {translate('resumeCenter.workspace.open', 'Open')}
          </Button>
          <button
            type="button"
            aria-expanded={expanded}
            aria-label={
              expanded
                ? translate('resumeCenter.workspace.collapse', 'Collapse')
                : translate('resumeCenter.workspace.expand', 'Expand')
            }
            onClick={() => setExpanded((value) => !value)}
            className="rounded p-1 hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            {expanded ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
          </button>
        </div>
      </header>
      {expanded ? (
        <div className="flex gap-3 px-4 pb-4">
          {firstTab && firstPane ? (
            <PanePreviewThumb
              hostId={row.hostId}
              tabId={firstTab.tabId}
              leafId={firstPane.leafId}
              enabled
              title={firstPane.title ?? firstTab.title}
              className="h-40 w-56"
            />
          ) : null}
          <ul className="flex min-w-0 flex-1 flex-col gap-2">
            {row.tabs.map((tab) => (
              <ResumeCenterTabRow key={tab.tabId} tab={tab} hostId={row.hostId} />
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  )
}
