import { useState } from 'react'
import { ChevronDown, ChevronRight, SquareTerminal } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import type { DeskTab } from '../../../../shared/desk-continuity-projection'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { WorkspaceRowModel } from './resume-center-model'
import {
  describeResidency,
  describeResumeVerdict,
  residencyTone,
  type ContinuityTone
} from './resume-center-presentation'
import { resumeDeskTab } from './resume-center-wake'
import { describeWakePhase, isWakeInFlight, useWakeState } from './resume-center-wake-copy'
import { PanePreviewThumb } from './PanePreviewThumb'

// Filled only for a reading we hold; unknown is hollow and more contrasty than idle (STYLEGUIDE).
const TONE_MARK: Record<ContinuityTone, string> = {
  warm: 'bg-[var(--status-success)] border-transparent',
  dormant: 'bg-transparent border-muted-foreground',
  stopped: 'bg-transparent border-muted-foreground',
  unknown: 'bg-transparent border-[var(--status-unknown)]'
}

export function ResidencyMark({
  residency
}: {
  residency: DeskTab['residency']
}): React.JSX.Element {
  const tone = residencyTone(residency)
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
      <span aria-hidden className={cn('size-2 rounded-full border', TONE_MARK[tone])} />
      {describeResidency(residency)}
    </span>
  )
}

export function ResumeCenterTabRow({
  tab,
  hostId,
  row
}: {
  tab: DeskTab
  hostId: ExecutionHostId
  row: WorkspaceRowModel
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const phase = useWakeState().phases.get(tab.tabId)
  const verdict = describeResumeVerdict(tab.resume)
  const Chevron = expanded ? ChevronDown : ChevronRight
  // Why not for warm: a row its host lists as running needs no wake; opening it is a reattach.
  const canResume = tab.residency !== 'warm' && phase?.phase !== 'running'
  return (
    <li
      data-testid="resume-center-tab-row"
      data-tab-id={tab.tabId}
      data-residency={tab.residency}
      data-wake-phase={phase?.phase ?? 'none'}
      className="rounded-md border border-border bg-card"
    >
      <div className="flex items-center gap-2 pr-2">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2 text-left hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <Chevron className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <SquareTerminal className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px]">{tab.title}</span>
            <span className="block truncate text-[11px] text-muted-foreground">
              {[
                tab.agent,
                translate('resumeCenter.tab.panes', '{{count}} panes', { count: tab.panes.length }),
                verdict
              ]
                .filter(Boolean)
                .join(' · ')}
            </span>
          </span>
          <ResidencyMark residency={tab.residency} />
        </button>
        {canResume ? (
          <Button
            size="sm"
            variant="outline"
            data-testid="resume-center-tab-resume"
            disabled={isWakeInFlight(phase)}
            onClick={() => void resumeDeskTab(row, tab.tabId)}
          >
            {translate('resumeCenter.resumeAction', 'Resume')}
          </Button>
        ) : null}
      </div>
      {phase ? (
        <p
          data-testid="resume-center-tab-wake"
          className="border-t border-border px-3 py-1.5 text-[11px] text-muted-foreground"
        >
          {describeWakePhase(phase)}
        </p>
      ) : null}
      {expanded ? (
        <div className="flex gap-2 overflow-x-auto border-t border-border px-3 py-2">
          {tab.panes.map((pane, index) => (
            <PanePreviewThumb
              key={pane.leafId ?? index}
              hostId={hostId}
              tabId={tab.tabId}
              leafId={pane.leafId}
              enabled
              title={pane.title ?? tab.title}
            />
          ))}
        </div>
      ) : null}
    </li>
  )
}
