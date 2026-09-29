import { Check, CircleDashed, Folder, ScanEye } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { formatUiRelativeTime } from '@/i18n/relative-time-format'
import { cn } from '@/lib/utils'
import type { MissionBrief, MissionStage } from '../../../../shared/mission-brief-types'
import { ClaimValue } from '../resume-center/ClaimValue'
import {
  describePhase,
  describeSignal,
  describeStageState,
  signalTone
} from './mission-brief-presentation'
import { MISSION_TONE_CLASS } from './mission-tone-class'

// Why five: the reference shows four stages; one more keeps the frontier's predecessor in view.
const STRIP_WINDOW = 5

function stripWindow(stages: MissionStage[]): { shown: MissionStage[]; before: number; after: number } {
  if (stages.length <= STRIP_WINDOW) {
    return { shown: stages, before: 0, after: 0 }
  }
  const current = Math.max(
    0,
    stages.findIndex((stage) => stage.state === 'current')
  )
  const start = Math.min(Math.max(0, current - 1), stages.length - STRIP_WINDOW)
  return {
    shown: stages.slice(start, start + STRIP_WINDOW),
    before: start,
    after: stages.length - start - STRIP_WINDOW
  }
}

function StageMark({ stage }: { stage: MissionStage }): React.JSX.Element {
  switch (stage.state) {
    case 'proven':
      return (
        <span className="flex size-6 items-center justify-center rounded-full bg-foreground text-background">
          <Check className="size-3.5" aria-hidden />
        </span>
      )
    case 'claimed':
      return <CircleDashed className="size-6 text-muted-foreground" aria-hidden />
    case 'current':
      return (
        <span className="flex size-6 items-center justify-center rounded-full border-[5px] border-foreground bg-background" />
      )
    case 'future':
      return <span className="size-6 rounded-full border-2 border-muted-foreground/50" />
  }
}

export function MissionStageStrip({ stages }: { stages: MissionStage[] }): React.JSX.Element {
  if (stages.length === 0) {
    return (
      <p className="text-[12px] text-muted-foreground">
        {translate('missionBrief.stage.noneRecorded', 'No phases recorded')}
      </p>
    )
  }
  const { shown, before, after } = stripWindow(stages)
  return (
    <div className="flex items-start gap-2" data-testid="mission-brief-stage-strip">
      {before > 0 ? (
        <span className="mt-1 text-[11px] text-muted-foreground">+{before}</span>
      ) : null}
      <ol className="flex items-start" aria-label={translate('missionBrief.stage.label', 'Mission phases')}>
        {shown.map((stage, index) => (
          <li
            key={stage.id}
            className="flex items-start"
            aria-label={`${describePhase(stage.id, stage.name)}: ${describeStageState(stage.state)}`}
            data-stage-state={stage.state}
          >
            {index > 0 ? <span className="mt-3 h-px w-8 bg-border" aria-hidden /> : null}
            <span className="flex w-24 flex-col items-center gap-1.5 text-center">
              <StageMark stage={stage} />
              <span
                className={cn(
                  'line-clamp-2 text-[12px] leading-tight',
                  stage.state === 'current' ? 'font-medium text-foreground' : 'text-muted-foreground'
                )}
                title={stage.name}
              >
                {stage.name}
              </span>
            </span>
          </li>
        ))}
      </ol>
      {after > 0 ? <span className="mt-1 text-[11px] text-muted-foreground">+{after}</span> : null}
    </div>
  )
}

export function MissionBriefHeader({
  brief,
  projectName,
  compact
}: {
  brief: MissionBrief
  projectName: string
  compact: boolean
}): React.JSX.Element {
  const tone = signalTone(brief.signal)
  return (
    <header className={cn('flex gap-4', compact ? 'flex-col' : 'items-start justify-between')}>
      <div className="flex items-start gap-4">
        <span className="flex size-14 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/30">
          <ScanEye className="size-6" aria-hidden />
        </span>
        <div className="min-w-0">
          <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
            {translate('missionBrief.kicker', 'Sidecar brief')}
          </p>
          <h2 className="text-2xl font-semibold leading-tight">
            {translate('missionBrief.title', 'Mission Brief')}
          </h2>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-[13px]">
            <span className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1">
              <Folder className="size-3.5" aria-hidden />
              <span className="max-w-48 truncate">{projectName}</span>
            </span>
            <span
              data-testid="mission-brief-signal"
              className={cn('inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1', MISSION_TONE_CLASS[tone])}
            >
              <span
                className={cn(
                  'size-2 rounded-full',
                  brief.signal === 'unknown' ? 'border border-current' : 'bg-current'
                )}
                aria-hidden
              />
              <ClaimValue testId="mission-brief-signal-label">{describeSignal(brief.signal)}</ClaimValue>
            </span>
            {brief.workstream ? (
              <span className="rounded-md border border-border px-2 py-1 font-mono text-[11px] text-muted-foreground">
                {brief.workstream}
              </span>
            ) : null}
          </div>
        </div>
      </div>
      <div className={cn('flex flex-col gap-3', compact ? 'items-start' : 'items-end')}>
        <p className="text-[12px] text-muted-foreground">
          {translate('missionBrief.readAt', 'Read {{when}}', {
            when: formatUiRelativeTime(brief.readAt - Date.now())
          })}
        </p>
        <MissionStageStrip stages={brief.stages} />
      </div>
    </header>
  )
}
