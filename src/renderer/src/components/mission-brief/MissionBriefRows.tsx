import {
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  Clock,
  Cog,
  Crosshair,
  Database,
  FileText,
  Flag,
  Link2,
  Play,
  User,
  Zap
} from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { formatUiRelativeTime } from '@/i18n/relative-time-format'
import { cn } from '@/lib/utils'
import type { MissionBrief } from '../../../../shared/mission-brief-types'
import { ClaimValue } from '../resume-center/ClaimValue'
import {
  describeAttention,
  describeContradiction,
  describeFreshness,
  describeLastVerified,
  describePhase
} from './mission-brief-presentation'
import { describeFrontierStatus } from './mission-frontier-status'
import { describeObjective } from './mission-objective-presentation'
import { MissionBriefNextActionCard } from './MissionBriefNextActionCard'
import { MISSION_TONE_CLASS } from './mission-tone-class'

// Full-variant row heights, measured from the r02 reference (docs/visual/references/mission-brief).
const FULL_ROW_HEIGHT = {
  objective: 'min-h-[52px]',
  frontier: 'min-h-[51.2px]',
  lastVerified: 'min-h-[67.2px]',
  nextAction: 'min-h-[84px]',
  unlocks: 'min-h-[56px]',
  intervention: 'min-h-[55.2px]',
  delegable: 'min-h-[72.8px]',
  blockers: 'min-h-[54.4px]',
  freshness: 'min-h-[56.8px]'
} as const

function BriefRow({
  icon: Icon,
  label,
  meta,
  metaIcon: MetaIcon,
  metaTitle,
  metaEnd = false,
  height,
  compact,
  wide = false,
  children
}: {
  icon: typeof Crosshair
  label: string
  meta?: string | null
  metaIcon?: typeof Crosshair
  metaTitle?: string
  /** Right-aligned so a meta wider than its column overflows leftward, as in the reference. */
  metaEnd?: boolean
  height: keyof typeof FULL_ROW_HEIGHT
  compact: boolean
  /** Full variant: the value takes the meta column too. */
  wide?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn(
        'grid items-center border-t border-border',
        compact
          ? 'grid-cols-[2.25rem_1fr] gap-x-4 gap-y-1 py-3'
          : cn(
              'grid-cols-[42px_174px_1fr_127px] gap-x-5 py-1 pr-[7.2px] pl-2',
              FULL_ROW_HEIGHT[height]
            )
      )}
    >
      <span
        className={cn(
          'flex items-center justify-center border border-border',
          compact ? 'size-9 rounded-md bg-muted/30 sm:size-10' : 'size-[42px] rounded-[10px]'
        )}
      >
        <Icon className={compact ? 'size-[18px]' : 'size-5'} aria-hidden />
      </span>
      <span className={cn('font-medium', compact ? 'text-[14px]' : 'text-[12.75px] leading-5')}>
        {label}
      </span>
      <div
        className={cn(
          'min-w-0',
          compact ? 'col-start-2 text-[14px]' : 'text-[13.7px] leading-[21px]',
          !compact && wide && 'col-span-2 -ml-[1.2px]'
        )}
      >
        {children}
      </div>
      {compact || wide ? null : meta ? (
        <span
          className={cn(
            'flex items-center gap-3 whitespace-nowrap text-muted-foreground',
            metaEnd ? 'justify-self-end text-[10px]' : 'text-[11px]'
          )}
          title={metaTitle}
        >
          {MetaIcon ? <MetaIcon className="size-[18px] shrink-0" aria-hidden /> : null}
          {meta}
        </span>
      ) : (
        <span />
      )}
    </div>
  )
}

function Chip({
  icon: Icon,
  compact,
  tall,
  children
}: {
  icon: typeof Crosshair
  compact: boolean
  tall: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex items-center border border-border',
        compact
          ? 'gap-2 rounded-md bg-muted/20 px-3 py-1.5 text-[13px]'
          : cn(
              'gap-[9.4px] rounded-lg bg-muted/40 pr-[11px] pl-3 text-[11.1px] whitespace-nowrap',
              tall ? 'h-[36.8px]' : 'h-[34.4px]'
            )
      )}
    >
      <Icon className="size-4 shrink-0" aria-hidden />
      {children}
    </span>
  )
}

export function MissionBriefRows({
  brief,
  compact,
  onViewPath
}: {
  brief: MissionBrief
  compact: boolean
  onViewPath: () => void
}): React.JSX.Element {
  const freshness = describeFreshness(brief)
  const objective = describeObjective(brief)
  const blockerLines = [
    ...(brief.blockers.kind === 'recorded' ? brief.blockers.lines : []),
    ...(brief.haltedRun
      ? [
          translate('missionBrief.blockers.halted', 'Autonomous run stopped: {{reason}}', {
            reason: brief.haltedRun.reason
          })
        ]
      : []),
    ...brief.contradictions.map(describeContradiction)
  ]
  const liveWork = brief.autonomous.filter((work) => work.live)
  const chipRow = cn('flex flex-wrap', compact ? 'gap-2' : 'gap-x-[11.2px] gap-y-2')
  return (
    <div className={cn('flex flex-col', !compact && 'border-b border-border')}>
      <BriefRow
        icon={Crosshair}
        label={translate('missionBrief.row.objective', 'Objective')}
        meta={compact ? objective.source : objective.sourceShort}
        metaTitle={objective.source}
        metaIcon={Flag}
        height="objective"
        compact={compact}
      >
        {/* Full: one line; the whole goal, its source and the milestone are in the full path. */}
        <ClaimValue
          testId="mission-brief-objective"
          className={cn(!compact && 'block truncate py-[7px]')}
          title={compact ? undefined : objective.text}
        >
          {objective.text}
        </ClaimValue>
        {objective.partial ? (
          <span className="ml-2 text-[12px] text-muted-foreground">
            {translate('missionBrief.objective.partial', '(partially read)')}
          </span>
        ) : null}
        {compact && objective.milestone ? (
          <span className="block text-[12px] text-muted-foreground">{objective.milestone}</span>
        ) : null}
      </BriefRow>

      <BriefRow
        icon={BarChart3}
        label={translate('missionBrief.row.frontier', 'Current frontier')}
        meta={
          brief.frontier.kind === 'known' ? describeFrontierStatus(brief.frontier.status) : null
        }
        metaIcon={Link2}
        height="frontier"
        compact={compact}
      >
        <ClaimValue testId="mission-brief-frontier" className={cn(!compact && 'block py-[7px]')}>
          {brief.frontier.kind === 'known'
            ? describePhase(brief.frontier.stageId, brief.frontier.name)
            : translate('missionBrief.frontier.unknown', 'Frontier unknown')}
        </ClaimValue>
      </BriefRow>

      <BriefRow
        icon={FileText}
        label={translate('missionBrief.row.lastVerified', 'Last verified result')}
        meta={
          brief.lastVerified.kind === 'verified'
            ? translate('missionBrief.meta.verified', 'Verified')
            : translate('missionBrief.meta.notVerified', 'Not verified')
        }
        metaIcon={CheckCircle2}
        height="lastVerified"
        compact={compact}
      >
        <ClaimValue
          testId="mission-brief-last-verified"
          className={cn(!compact && 'block py-[7px]')}
        >
          {describeLastVerified(brief)}
        </ClaimValue>
      </BriefRow>

      <BriefRow
        icon={Play}
        label={translate('missionBrief.row.nextAction', 'Next best action')}
        height="nextAction"
        compact={compact}
        wide
      >
        <MissionBriefNextActionCard brief={brief} compact={compact} onViewPath={onViewPath} />
      </BriefRow>

      <BriefRow
        icon={Link2}
        label={translate('missionBrief.row.unlocks', 'Unlocks')}
        height="unlocks"
        compact={compact}
        wide
      >
        <ClaimValue testId="mission-brief-unlocks" className={chipRow}>
          {brief.unlocks.length > 0
            ? brief.unlocks.map((unlock) => (
                <Chip key={unlock.stageId} icon={Zap} compact={compact} tall>
                  {describePhase(unlock.stageId, unlock.name)}
                </Chip>
              ))
            : translate(
                'missionBrief.unlocks.none',
                'Nothing becomes reachable from this phase alone'
              )}
        </ClaimValue>
      </BriefRow>

      <BriefRow
        icon={User}
        label={translate('missionBrief.row.intervention', 'Your intervention')}
        meta={translate('missionBrief.meta.human', 'Human action')}
        metaIcon={User}
        height="intervention"
        compact={compact}
      >
        <ClaimValue
          testId="mission-brief-intervention"
          className={cn('flex flex-col gap-1', !compact && 'py-[7px]')}
        >
          {brief.humanAttention.length > 0
            ? brief.humanAttention.map((item, index) => (
                <span key={index}>{describeAttention(item)}</span>
              ))
            : translate('missionBrief.intervention.none', 'Nothing recorded as waiting on you')}
        </ClaimValue>
      </BriefRow>

      {compact ? null : (
        <BriefRow
          icon={Cog}
          label={translate('missionBrief.row.delegable', 'Delegable work already running')}
          height="delegable"
          compact={compact}
          wide
        >
          <ClaimValue testId="mission-brief-delegable" className={chipRow}>
            {liveWork.length > 0
              ? liveWork.map((work) => (
                  <Chip key={work.missionId} icon={Zap} compact={compact} tall={false}>
                    {translate('missionBrief.delegable.run', 'Autonomous run {{id}}', {
                      id: work.missionId
                    })}
                    {work.reason ? (
                      <span className="text-muted-foreground">· {work.reason}</span>
                    ) : null}
                  </Chip>
                ))
              : translate('missionBrief.delegable.none', 'No autonomous run recorded as running')}
          </ClaimValue>
        </BriefRow>
      )}

      <BriefRow
        icon={AlertTriangle}
        label={translate('missionBrief.row.blockers', 'Risks / blockers')}
        // Only when the row lists a halted run: the one blocker line that waits on a person.
        meta={brief.haltedRun ? translate('missionBrief.meta.humanBlock', 'Human blocker') : null}
        metaIcon={AlertTriangle}
        height="blockers"
        compact={compact}
      >
        <ClaimValue
          testId="mission-brief-blockers"
          className={cn('flex flex-col gap-1', !compact && 'py-[7px]')}
        >
          {blockerLines.length > 0
            ? blockerLines.map((line, index) => <span key={index}>{line}</span>)
            : brief.blockers.kind === 'recorded'
              ? translate('missionBrief.blockers.noneRecorded', 'None recorded in STATE.md')
              : translate('missionBrief.blockers.notRecorded', 'Blockers not recorded')}
        </ClaimValue>
      </BriefRow>

      <BriefRow
        icon={Database}
        label={translate('missionBrief.row.freshness', 'Evidence freshness')}
        meta={translate('missionBrief.meta.read', 'Read {{when}}', {
          when: formatUiRelativeTime(brief.readAt - Date.now(), 'short')
        })}
        metaIcon={Clock}
        metaEnd
        height="freshness"
        compact={compact}
      >
        {/* Full: a current state reads as plain dim text; stale and unknown keep their tone. */}
        <ClaimValue
          testId="mission-brief-freshness"
          className={cn(
            !compact && freshness.tone === 'next'
              ? 'block py-[7px] text-[13.8px] text-foreground/80'
              : cn(
                  'inline-flex rounded-md border px-2 py-0.5 text-[13px]',
                  MISSION_TONE_CLASS[freshness.tone]
                )
          )}
        >
          {freshness.text}
        </ClaimValue>
      </BriefRow>
    </div>
  )
}
