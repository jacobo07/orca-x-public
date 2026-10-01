import { Check, CircleDashed, Folder, RefreshCw, ScanEye } from 'lucide-react'
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

// Why four in full: the reference strip shows four; compact keeps one more for the predecessor.
const STRIP_WINDOW = { full: 4, compact: 5 } as const
// Column widths measured from the r02 reference (docs/visual/references/mission-brief); uniform otherwise.
const FULL_COLUMNS = [97.6, 101, 104.8, 105.2]
// A connector stops 2.8px short of each 22px mark.
const CONNECTOR_INSET = 13.8

function stripWindow(
  stages: MissionStage[],
  size: number
): {
  shown: MissionStage[]
  before: number
  after: number
} {
  if (stages.length <= size) {
    return { shown: stages, before: 0, after: 0 }
  }
  const current = Math.max(
    0,
    stages.findIndex((stage) => stage.state === 'current')
  )
  const start = Math.min(Math.max(0, current - 1), stages.length - size)
  return {
    shown: stages.slice(start, start + size),
    before: start,
    after: stages.length - start - size
  }
}

function StageMark({ stage, full }: { stage: MissionStage; full: boolean }): React.JSX.Element {
  const size = full ? 'size-[22px]' : 'size-6'
  switch (stage.state) {
    case 'proven':
      return (
        <span
          className={cn(
            'flex items-center justify-center rounded-full',
            size,
            full ? 'bg-muted-foreground text-card' : 'bg-foreground text-background'
          )}
        >
          <Check
            className={full ? 'size-[13px]' : 'size-3.5'}
            strokeWidth={full ? 3 : 2}
            aria-hidden
          />
        </span>
      )
    case 'claimed':
      return <CircleDashed className={cn(size, 'text-muted-foreground')} aria-hidden />
    case 'current':
      return (
        <span
          className={cn(
            'flex items-center justify-center rounded-full border-[5px] border-foreground',
            size,
            !full && 'bg-background'
          )}
        />
      )
    case 'future':
      return (
        <span
          className={cn(
            'rounded-full',
            size,
            full ? 'border-[2.6px] border-input' : 'border-2 border-muted-foreground/50'
          )}
        />
      )
  }
}

// Why by the later stage's state: the line reads as the path INTO that stage.
function connectorClass(state: MissionStage['state']): string {
  switch (state) {
    case 'current':
      return 'bg-linear-to-r from-muted-foreground/85 to-foreground/80'
    case 'future':
      return 'bg-linear-to-r from-foreground/10 to-foreground/9'
    default:
      return 'bg-linear-to-r from-muted-foreground/33 to-muted-foreground/42'
  }
}

function FullStageStrip({ shown }: { shown: MissionStage[] }): React.JSX.Element {
  const widths = shown.length === FULL_COLUMNS.length ? FULL_COLUMNS : shown.map(() => 102)
  return (
    <ol
      className="grid"
      style={{ gridTemplateColumns: widths.map((width) => `${width}px`).join(' ') }}
      aria-label={translate('missionBrief.stage.label', 'Mission phases')}
    >
      {shown.map((stage, index) => (
        <li
          key={stage.id}
          className="relative flex min-w-0 flex-col items-center gap-[10.8px]"
          aria-label={`${describePhase(stage.id, stage.name)}: ${describeStageState(stage.state)}`}
          data-stage-state={stage.state}
        >
          {index > 0 ? (
            <span
              className={cn('absolute top-[10.2px] h-[1.6px]', connectorClass(stage.state))}
              style={{
                right: `calc(50% + ${CONNECTOR_INSET}px)`,
                width: (widths[index - 1] + widths[index]) / 2 - 2 * CONNECTOR_INSET
              }}
              aria-hidden
            />
          ) : null}
          <StageMark stage={stage} full />
          <span
            className={cn(
              'max-w-full truncate leading-[14px]',
              stage.state === 'current'
                ? 'text-[11.8px] font-medium text-foreground'
                : 'text-[10.6px] text-muted-foreground'
            )}
            title={stage.name}
          >
            {stage.name}
          </span>
        </li>
      ))}
    </ol>
  )
}

export function MissionStageStrip({
  stages,
  full = false
}: {
  stages: MissionStage[]
  full?: boolean
}): React.JSX.Element {
  if (stages.length === 0) {
    return (
      <p className="text-[12px] text-muted-foreground">
        {translate('missionBrief.stage.noneRecorded', 'No phases recorded')}
      </p>
    )
  }
  const { shown, before, after } = stripWindow(
    stages,
    full ? STRIP_WINDOW.full : STRIP_WINDOW.compact
  )
  return (
    <div className="flex items-start gap-2" data-testid="mission-brief-stage-strip">
      {before > 0 ? (
        <span className="mt-1 text-[11px] text-muted-foreground">+{before}</span>
      ) : null}
      {full ? (
        <FullStageStrip shown={shown} />
      ) : (
        <ol
          className="flex items-start"
          aria-label={translate('missionBrief.stage.label', 'Mission phases')}
        >
          {shown.map((stage, index) => (
            <li
              key={stage.id}
              className="flex items-start"
              aria-label={`${describePhase(stage.id, stage.name)}: ${describeStageState(stage.state)}`}
              data-stage-state={stage.state}
            >
              {index > 0 ? <span className="mt-3 h-px w-8 bg-border" aria-hidden /> : null}
              <span className="flex w-24 flex-col items-center gap-1.5 text-center">
                <StageMark stage={stage} full={false} />
                <span
                  className={cn(
                    'line-clamp-2 text-[12px] leading-tight',
                    stage.state === 'current'
                      ? 'font-medium text-foreground'
                      : 'text-muted-foreground'
                  )}
                  title={stage.name}
                >
                  {stage.name}
                </span>
              </span>
            </li>
          ))}
        </ol>
      )}
      {after > 0 ? <span className="mt-1 text-[11px] text-muted-foreground">+{after}</span> : null}
    </div>
  )
}

export function MissionBriefHeader({
  brief,
  projectName,
  compact,
  reading,
  onRefresh
}: {
  brief: MissionBrief
  projectName: string
  compact: boolean
  reading: boolean
  onRefresh: () => void
}): React.JSX.Element {
  const tone = signalTone(brief.signal)
  const full = !compact
  return (
    <header
      className={cn(
        'flex',
        compact ? 'flex-col gap-4' : 'h-[112.8px] items-start justify-between pl-[3.2px]'
      )}
    >
      <div className={cn('flex items-start', compact ? 'gap-4' : 'gap-5')}>
        <span
          className={cn(
            'flex shrink-0 items-center justify-center border border-border',
            compact ? 'size-14 rounded-lg bg-muted/30' : 'size-[54.4px] rounded-[10px]'
          )}
        >
          <ScanEye className={compact ? 'size-6' : 'size-[26px]'} aria-hidden />
        </span>
        <div className="min-w-0">
          <p
            className={cn(
              'uppercase text-muted-foreground',
              compact
                ? 'text-[11px] font-medium tracking-[0.08em]'
                : 'mt-[1.5px] text-[11.4px] leading-[14px] tracking-[0.04em]'
            )}
          >
            {translate('missionBrief.kicker', 'Sidecar brief')}
          </p>
          <h2
            className={cn(
              'font-semibold',
              compact
                ? 'text-2xl leading-tight'
                : 'mt-[3.6px] text-[29.1px] leading-[40px] tracking-[-0.01em]'
            )}
          >
            {translate('missionBrief.title', 'Mission Brief')}
          </h2>
          <div
            className={cn(
              'flex flex-wrap items-center',
              compact ? 'mt-2 gap-2 text-[13px]' : 'mt-[6px] gap-3 text-[12.4px]'
            )}
          >
            <span
              className={cn(
                'inline-flex items-center border border-border',
                compact
                  ? 'gap-1.5 rounded-md px-2.5 py-1'
                  : 'h-[30px] gap-2.5 rounded-lg pr-[13.5px] pl-3'
              )}
            >
              <Folder className={compact ? 'size-3.5' : 'size-4'} aria-hidden />
              <span className="max-w-48 truncate">{projectName}</span>
            </span>
            <span
              data-testid="mission-brief-signal"
              className={cn(
                'inline-flex items-center border',
                compact
                  ? 'gap-1.5 rounded-md px-2.5 py-1'
                  : 'h-[30px] gap-2.5 rounded-lg pr-[13.5px] pl-[13px]',
                MISSION_TONE_CLASS[tone]
              )}
            >
              <span
                className={cn(
                  'rounded-full',
                  compact ? 'size-2' : 'size-[13px]',
                  brief.signal === 'unknown' ? 'border border-current' : 'bg-current'
                )}
                aria-hidden
              />
              <ClaimValue testId="mission-brief-signal-label">
                {describeSignal(brief.signal)}
              </ClaimValue>
            </span>
            {brief.workstream ? (
              <span className="rounded-md border border-border px-2 py-1 font-mono text-[11px] text-muted-foreground">
                {brief.workstream}
              </span>
            ) : null}
          </div>
        </div>
      </div>
      <div className={cn('flex flex-col', compact ? 'items-start gap-3' : 'items-end')}>
        <div className="flex items-center gap-2">
          {full ? (
            <button
              type="button"
              data-testid="mission-brief-refresh"
              disabled={reading}
              onClick={onRefresh}
              aria-label={translate('missionBrief.refresh', 'Re-read mission records')}
              // Why size-6 with -my-1: a 24px target that still takes the read time's 16px line.
              className="-my-1 flex size-6 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
            >
              <RefreshCw
                className={cn('size-3.5', reading && 'motion-safe:animate-spin')}
                aria-hidden
              />
            </button>
          ) : null}
          <p className={cn('text-[12px] text-muted-foreground', full && 'pr-[5.6px] leading-4')}>
            {translate('missionBrief.readAt', 'Read {{when}}', {
              when: formatUiRelativeTime(brief.readAt - Date.now(), 'short')
            })}
          </p>
        </div>
        <div className={cn(full && 'mt-[28.6px] -mr-[17.8px]')}>
          <MissionStageStrip stages={brief.stages} full={full} />
        </div>
      </div>
    </header>
  )
}
