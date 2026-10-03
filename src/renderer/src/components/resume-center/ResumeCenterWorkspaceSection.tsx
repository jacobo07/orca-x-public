import { useRef, useState } from 'react'
import { ChevronDown, ChevronUp, FolderGit2, GitBranch, Server, Target } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { formatUiRelativeTime } from '@/i18n/relative-time-format'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { getExecutionHostLabel } from '../../../../shared/execution-host'
import { describeSignalShort, signalTone } from '../mission-brief/mission-brief-presentation'
import { MISSION_TONE_CLASS } from '../mission-brief/mission-tone-class'
import { useCachedMissionBriefResult } from '../mission-brief/use-mission-brief'
import {
  rowMissionChip,
  useMissionRecordsPresence
} from '../mission-brief/use-mission-records-presence'
import type { WorkspaceRowModel } from './resume-center-model'
import {
  describeSessionsWord,
  describeWindow,
  describeWorkspaceName
} from './resume-center-presentation'
import { restoreWorkspaceLayoutOnly } from './resume-center-restore'
import { workspaceAgentCount, workspaceBranch } from './resume-center-workspace-facts'
import { useSeenInView } from './use-seen-in-view'
import { ClaimValue } from './ClaimValue'
import { PanePreviewThumb } from './PanePreviewThumb'
import { ResumeCenterTabRow } from './ResumeCenterTabRow'
import { ResumeCenterOrphanRow } from './ResumeCenterOrphanRow'

const CHIP = 'inline-flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5'

export function ResumeCenterWorkspaceSection({
  row,
  selected,
  onSelect,
  onShowBrief
}: {
  row: WorkspaceRowModel
  selected: boolean
  onSelect: () => void
  /** Selects this row without toggling: the chip must never hide the brief it advertises. */
  onShowBrief: () => void
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(true)
  const sectionRef = useRef<HTMLElement>(null)
  // Why: previews replay recorded history; only sections the person can see pay for it.
  const inView = useSeenInView(sectionRef)
  const missionChip = rowMissionChip(
    useCachedMissionBriefResult(row.hostId, row.key),
    useMissionRecordsPresence(row.hostId, row.key)
  )
  const missionLabel =
    missionChip?.kind === 'signal'
      ? describeSignalShort(missionChip.signal)
      : translate('resumeCenter.workspace.missionAvailable', 'Mission Brief')
  const branch = useAppStore((s) => workspaceBranch(s.worktreesByRepo, row.key))
  const firstTab = row.tabs[0]
  const firstPane = firstTab?.panes[0]
  const name = describeWorkspaceName(row.identity, row.key)
  const path = row.identity.kind === 'known' ? row.identity.path : null
  const agents = workspaceAgentCount(row)
  return (
    <section
      ref={sectionRef}
      data-testid="resume-center-workspace"
      data-workspace-key={row.key}
      data-selected={selected ? 'true' : undefined}
      aria-label={name}
      className={cn('rounded-lg border bg-card/40', selected ? 'border-ring' : 'border-border')}
    >
      <header className="flex items-start gap-3 px-4 py-3">
        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-background">
          <FolderGit2 className="size-4 text-muted-foreground" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-semibold">
            {/* Why a button: selecting a row opens its Mission Brief, reachable from the keyboard. */}
            <button
              type="button"
              data-testid="resume-center-workspace-select"
              aria-pressed={selected}
              onClick={onSelect}
              className="max-w-full truncate rounded-sm text-left hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              {name}
            </button>
          </h3>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
            {path ? <span className="min-w-0 truncate font-mono">{path}</span> : null}
            {branch ? (
              <span className={CHIP} data-testid="resume-center-workspace-branch">
                <GitBranch className="size-3" aria-hidden />
                <ClaimValue testId="resume-center-workspace-branch-name">{branch}</ClaimValue>
              </span>
            ) : null}
            {row.hostId !== 'local' ? (
              <span className={CHIP}>
                <Server className="size-3" aria-hidden />
                {getExecutionHostLabel(row.hostId)}
              </span>
            ) : null}
            <span className={CHIP}>{describeWindow(row.window, row.windowOrder)}</span>
            {missionChip ? (
              // Why a button: the chip is how a person learns the brief exists, and it opens it.
              <button
                type="button"
                data-testid="resume-center-workspace-mission-chip"
                data-mission-chip={missionChip.kind}
                onClick={onShowBrief}
                aria-label={translate(
                  'resumeCenter.workspace.missionChipLabel',
                  '{{label}}: show the Mission Brief for {{name}}',
                  { label: missionLabel, name }
                )}
                title={
                  missionChip.kind === 'signal' ? (missionChip.action ?? undefined) : undefined
                }
                className={cn(
                  CHIP,
                  'hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                  missionChip.kind === 'signal'
                    ? MISSION_TONE_CLASS[signalTone(missionChip.signal)]
                    : 'text-foreground'
                )}
              >
                <Target className="size-3" aria-hidden />
                {missionChip.kind === 'signal' ? (
                  <ClaimValue testId="resume-center-workspace-mission-signal">
                    {missionLabel}
                  </ClaimValue>
                ) : (
                  <ClaimValue testId="resume-center-workspace-mission-available">
                    {missionLabel}
                  </ClaimValue>
                )}
              </button>
            ) : null}
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground">
            <ClaimValue testId="resume-center-workspace-file-count">{row.openFileCount}</ClaimValue>{' '}
            {translate('resumeCenter.workspace.files', 'open files')}
            {' · '}
            <ClaimValue testId="resume-center-workspace-agent-count">{agents}</ClaimValue>{' '}
            {translate('resumeCenter.workspace.agents', 'agent tabs')}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3 text-[11px] text-muted-foreground">
          {row.lastVisitedAt !== null ? (
            <span>{formatUiRelativeTime(row.lastVisitedAt - Date.now())}</span>
          ) : null}
          <span>
            <ClaimValue testId="resume-center-workspace-session-count">
              {row.counts.tabs}
            </ClaimValue>{' '}
            {describeSessionsWord(row.counts.tabs)}
          </span>
          <Button
            size="sm"
            variant="outline"
            data-testid="resume-center-workspace-open"
            disabled={row.identity.kind === 'missing'}
            onClick={() => void restoreWorkspaceLayoutOnly(row)}
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
              enabled={inView}
              title={firstPane.title ?? firstTab.title}
              placement="hero"
              className="h-48 w-52"
            />
          ) : null}
          <ul className="flex min-w-0 flex-1 flex-col gap-2">
            {row.tabs.map((tab) => (
              <ResumeCenterTabRow key={tab.tabId} tab={tab} hostId={row.hostId} row={row} />
            ))}
            {row.orphanSessions.map((orphan) => (
              <ResumeCenterOrphanRow key={orphan.paneKey} orphan={orphan} row={row} />
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  )
}
