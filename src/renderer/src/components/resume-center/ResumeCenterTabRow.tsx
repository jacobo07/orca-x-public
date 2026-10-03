import { useRef, useState } from 'react'
import { ChevronDown, ChevronRight, SquareTerminal } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { AgentIcon, getAgentLabel } from '@/lib/agent-catalog'
import { Button } from '@/components/ui/button'
import type { DeskTab } from '../../../../shared/desk-continuity-projection'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { WorkspaceRowModel } from './resume-center-model'
import { StatusMark, type StatusState } from '@/components/ui/status-mark'
import {
  describePaneCount,
  describeResidency,
  describeResumeVerdict,
  residencyTone,
  type ContinuityTone
} from './resume-center-presentation'
import { resumeDeskTab } from './resume-center-wake'
import { describeWakePhase, isWakeInFlight, useWakeState } from './resume-center-wake-copy'
import { INLINE_PANE_THUMBS, tabMonogram } from './resume-center-workspace-facts'
import { useSeenInView } from './use-seen-in-view'
import { PanePreviewThumb } from './PanePreviewThumb'

// STYLEGUIDE: dormant/parked/not running are IDLE; only a live reading is HEALTHY.
const TONE_STATE: Record<ContinuityTone, StatusState> = {
  warm: 'HEALTHY',
  dormant: 'IDLE',
  stopped: 'IDLE',
  unknown: 'UNKNOWN'
}

export function ResidencyMark({
  residency
}: {
  residency: DeskTab['residency']
}): React.JSX.Element {
  return (
    <span
      data-row-fact="residency"
      className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-[11px] text-muted-foreground"
    >
      <StatusMark state={TONE_STATE[residencyTone(residency)]} />
      {describeResidency(residency)}
    </span>
  )
}

function TabMonogram({ tab }: { tab: DeskTab }): React.JSX.Element {
  return (
    <span
      aria-hidden
      className="flex size-8 shrink-0 items-center justify-center rounded-full border border-border bg-background text-[12px] font-medium text-muted-foreground"
    >
      {tab.agent ? <AgentIcon agent={tab.agent as TuiAgent} size={14} /> : tabMonogram(tab)}
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
  const stripRef = useRef<HTMLDivElement>(null)
  // Why the strip itself: a strip below the fold or hidden at narrow widths never intersects, so it never replays history.
  const stripSeen = useSeenInView(stripRef)
  const inlinePanes = tab.panes.slice(0, INLINE_PANE_THUMBS)
  const hiddenPanes = tab.panes.length - inlinePanes.length
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
          <TabMonogram tab={tab} />
          {/* Why the title shrinks: narrowed, it truncates rather than squeezing the facts into the mark. */}
          <span className="w-44 min-w-20 shrink">
            <span className="block truncate text-[13px] font-medium">{tab.title}</span>
            <span className="block truncate text-[11px] text-muted-foreground">
              {tab.agent
                ? getAgentLabel(tab.agent as TuiAgent)
                : translate('resumeCenter.tab.shell', 'Terminal')}
            </span>
          </span>
          <span className="flex min-w-16 flex-1 flex-col gap-0.5 text-[11px] text-muted-foreground">
            <span
              data-row-fact="panes"
              className="inline-flex items-center gap-1 overflow-hidden whitespace-nowrap"
            >
              <SquareTerminal className="size-3 shrink-0" aria-hidden />
              {describePaneCount(tab.panes.length)}
            </span>
            {verdict ? <span className="truncate">{verdict}</span> : null}
          </span>
          <ResidencyMark residency={tab.residency} />
        </button>
        {/* Why aria-hidden: a glance; the same screens are labelled in the expanded strip. */}
        <div ref={stripRef} aria-hidden className="hidden shrink-0 items-center gap-1.5 lg:flex">
          {inlinePanes.map((pane, index) => (
            <PanePreviewThumb
              key={pane.leafId ?? index}
              hostId={hostId}
              tabId={tab.tabId}
              leafId={pane.leafId}
              enabled={stripSeen}
              title={pane.title ?? tab.title}
              placement="inline"
              className="h-14 w-24"
            />
          ))}
          {hiddenPanes > 0 ? (
            <span className="text-[11px] text-muted-foreground">+{hiddenPanes}</span>
          ) : null}
        </div>
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
