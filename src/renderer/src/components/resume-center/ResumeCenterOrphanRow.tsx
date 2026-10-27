import { Bot } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import { getAgentLabel } from '@/lib/agent-catalog'
import type { DeskOrphanSession } from '../../../../shared/desk-continuity-projection'
import type { WorkspaceRowModel } from './resume-center-model'
import { describeResumeVerdict } from './resume-center-presentation'
import { resumeDeskOrphan } from './resume-center-wake'
import { describeWakePhase, isWakeInFlight, useWakeState } from './resume-center-wake-copy'

/** An agent whose tab is gone. Nothing to restore as layout; Resume starts it again in a new tab. */
export function ResumeCenterOrphanRow({
  orphan,
  row
}: {
  orphan: DeskOrphanSession
  row: WorkspaceRowModel
}): React.JSX.Element {
  const phase = useWakeState().phases.get(orphan.paneKey)
  const agentLabel =
    getAgentLabel(orphan.agent as Parameters<typeof getAgentLabel>[0]) ?? orphan.agent
  return (
    <li
      data-testid="resume-center-orphan-row"
      data-pane-key={orphan.paneKey}
      data-wake-phase={phase?.phase ?? 'none'}
      className="rounded-md border border-dashed border-border bg-card"
    >
      <div className="flex items-center gap-3 px-3 py-2">
        <Bot className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px]">
            {translate('resumeCenter.orphan.title', '{{agent}} session, tab closed', {
              agent: agentLabel
            })}
          </span>
          <span className="block truncate text-[11px] text-muted-foreground">
            {[
              translate(
                'resumeCenter.orphan.note',
                'No tab to restore; Resume opens it in a new tab.'
              ),
              describeResumeVerdict(orphan.resume)
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
        </span>
        {phase?.phase !== 'running' ? (
          <Button
            size="sm"
            variant="outline"
            data-testid="resume-center-orphan-resume"
            disabled={isWakeInFlight(phase)}
            onClick={() => void resumeDeskOrphan(row, orphan.paneKey)}
          >
            {translate('resumeCenter.resumeAction', 'Resume')}
          </Button>
        ) : null}
      </div>
      {phase ? (
        <p className="border-t border-border px-3 py-1.5 text-[11px] text-muted-foreground">
          {describeWakePhase(phase)}
        </p>
      ) : null}
    </li>
  )
}
