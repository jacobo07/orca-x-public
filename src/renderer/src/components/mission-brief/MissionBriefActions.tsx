import { useState } from 'react'
import { Map as MapIcon, Play, User } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { MissionBrief } from '../../../../shared/mission-brief-types'
import type { WorkspaceRowModel } from '../resume-center/resume-center-model'
import type { WakePhase } from '../resume-center/resume-center-wake-state'
import { planContinue, planNeedsMe, runContinue, runNeedsMe } from './mission-brief-actions'
import { getMissionBriefEntry, readMissionBriefInto } from './use-mission-brief'

function continueDisabledReason(brief: MissionBrief, row: WorkspaceRowModel | null): string | null {
  if (!row) {
    return translate(
      'missionBrief.continue.noDesk',
      'Open this brief from the Resume Center to continue'
    )
  }
  const plan = planContinue(brief, row)
  if (plan.kind === 'autonomous') {
    return translate(
      'missionBrief.continue.autonomous',
      'Progressing autonomously — nothing to start'
    )
  }
  if (plan.kind === 'no-agent') {
    return translate(
      'missionBrief.continue.noAgent',
      'No agent session in this workspace to resume'
    )
  }
  return null
}

function describeWake(phase: WakePhase): string {
  switch (phase.phase) {
    case 'running':
      return translate('missionBrief.continue.running', 'Agent session is running')
    case 'refused':
      return translate(
        'missionBrief.continue.refused',
        'Not started: the host refused another session now'
      )
    default:
      return translate('missionBrief.continue.notStarted', 'The agent session did not start')
  }
}

export function MissionBriefActions({
  brief,
  row,
  hostId,
  workspaceKey,
  onViewPath,
  compact
}: {
  brief: MissionBrief
  row: WorkspaceRowModel | null
  hostId: ExecutionHostId
  workspaceKey: string
  onViewPath: () => void
  compact: boolean
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<string | null>(null)
  const continueBlocked = continueDisabledReason(brief, row)
  const needsMe = row ? planNeedsMe(brief, row) : { kind: 'nothing-recorded' as const }

  const onContinue = async (): Promise<void> => {
    if (!row) {
      return
    }
    setBusy(true)
    try {
      // Why re-read: the frontier or an autonomous run may have changed since the brief was drawn.
      await readMissionBriefInto(hostId, workspaceKey, true)
      const latest = getMissionBriefEntry(hostId, workspaceKey)
      const fresh =
        latest?.status === 'loaded' && latest.result.status === 'read' ? latest.result.brief : null
      if (!fresh) {
        setOutcome(
          translate(
            'missionBrief.continue.rereadFailed',
            'The mission could not be re-read, so nothing was started'
          )
        )
        return
      }
      const phase = await runContinue(planContinue(fresh, row), row)
      setOutcome(phase === null ? continueDisabledReason(fresh, row) : describeWake(phase))
    } finally {
      setBusy(false)
    }
  }

  const onNeedsMe = async (): Promise<void> => {
    if (!row) {
      return
    }
    setBusy(true)
    try {
      const opened = await runNeedsMe(needsMe, row)
      setOutcome(
        opened
          ? translate(
              'missionBrief.needsMe.opened',
              'Opened where this waits for you. Guided help is not available yet.'
            )
          : translate('missionBrief.needsMe.notOpened', 'The workspace could not be opened')
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-2 border-t border-border pt-4">
      <div className={cn('grid gap-3', compact ? 'grid-cols-1' : 'grid-cols-[1fr_1.5fr_1fr]')}>
        <Button
          data-testid="mission-brief-continue"
          className="h-12 justify-start gap-3 bg-foreground text-[15px] text-background hover:bg-foreground/90"
          disabled={busy || continueBlocked !== null}
          onClick={() => void onContinue()}
        >
          <Play className="size-5" aria-hidden />
          {translate('missionBrief.action.continue', 'Continue mission')}
        </Button>
        <Button
          data-testid="mission-brief-needs-me"
          variant="outline"
          className="h-12 justify-start gap-3 text-[15px]"
          disabled={busy || needsMe.kind === 'nothing-recorded'}
          onClick={() => void onNeedsMe()}
        >
          <User className="size-5" aria-hidden />
          {translate('missionBrief.action.needsMe', 'Do what needs me')}
        </Button>
        <Button
          data-testid="mission-brief-view-path"
          variant="outline"
          className="h-12 justify-start gap-3 text-[15px]"
          disabled={brief.stages.length === 0}
          onClick={onViewPath}
        >
          <MapIcon className="size-5" aria-hidden />
          {translate('missionBrief.action.viewPath', 'View full path')}
        </Button>
      </div>
      {/* Why visible text, not a tooltip: a disabled button cannot be hovered or focused to read it. */}
      {continueBlocked ? (
        <p className="text-[12px] text-muted-foreground">{continueBlocked}</p>
      ) : null}
      {needsMe.kind === 'nothing-recorded' ? (
        <p className="text-[12px] text-muted-foreground">
          {translate('missionBrief.needsMe.nothing', 'Nothing is recorded as waiting on you')}
        </p>
      ) : null}
      {outcome ? (
        <p
          role="status"
          className="text-[12px] text-muted-foreground"
          data-testid="mission-brief-action-outcome"
        >
          {outcome}
        </p>
      ) : null}
    </div>
  )
}
