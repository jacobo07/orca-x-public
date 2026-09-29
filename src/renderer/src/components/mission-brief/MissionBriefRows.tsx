import {
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  Clock,
  Cog,
  Copy,
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
import { MISSION_TONE_CLASS } from './mission-tone-class'

function BriefRow({
  icon: Icon,
  label,
  meta,
  metaIcon: MetaIcon,
  compact,
  children
}: {
  icon: typeof Crosshair
  label: string
  meta?: string | null
  metaIcon?: typeof Crosshair
  compact: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn(
        'grid items-center gap-x-4 border-t border-border py-3',
        compact ? 'grid-cols-[2.25rem_1fr] gap-y-1' : 'grid-cols-[2.75rem_12rem_1fr_11rem]'
      )}
    >
      <span className="flex size-9 items-center justify-center rounded-md border border-border bg-muted/30 sm:size-10">
        <Icon className="size-[18px]" aria-hidden />
      </span>
      <span className="text-[14px] font-medium">{label}</span>
      <div className={cn('min-w-0 text-[14px]', compact && 'col-start-2')}>{children}</div>
      {!compact && meta ? (
        <span className="flex items-center gap-2 text-[12px] text-muted-foreground">
          {MetaIcon ? <MetaIcon className="size-4 shrink-0" aria-hidden /> : null}
          {meta}
        </span>
      ) : !compact ? (
        <span />
      ) : null}
    </div>
  )
}

function Chip({
  icon: Icon,
  children
}: {
  icon: typeof Crosshair
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <span className="inline-flex items-center gap-2 rounded-md border border-border bg-muted/20 px-3 py-1.5 text-[13px]">
      <Icon className="size-4 shrink-0" aria-hidden />
      {children}
    </span>
  )
}

export function MissionBriefRows({
  brief,
  compact
}: {
  brief: MissionBrief
  compact: boolean
}): React.JSX.Element {
  const freshness = describeFreshness(brief)
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
  return (
    <div className="flex flex-col">
      <BriefRow
        icon={Crosshair}
        label={translate('missionBrief.row.objective', 'Objective')}
        meta={translate('missionBrief.meta.goal', 'Project goal')}
        metaIcon={Flag}
        compact={compact}
      >
        <ClaimValue testId="mission-brief-objective">
          {brief.objective.kind === 'known'
            ? brief.objective.text
            : translate(
                'missionBrief.objective.unknown',
                'No milestone named in the planning state'
              )}
        </ClaimValue>
        {brief.objective.kind === 'known' && brief.objective.partial ? (
          <span className="ml-2 text-[12px] text-muted-foreground">
            {translate('missionBrief.objective.partial', '(partially read)')}
          </span>
        ) : null}
      </BriefRow>

      <BriefRow
        icon={BarChart3}
        label={translate('missionBrief.row.frontier', 'Current frontier')}
        meta={brief.frontier.kind === 'known' ? brief.frontier.status : null}
        metaIcon={Link2}
        compact={compact}
      >
        <ClaimValue testId="mission-brief-frontier">
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
        compact={compact}
      >
        <ClaimValue testId="mission-brief-last-verified">{describeLastVerified(brief)}</ClaimValue>
      </BriefRow>

      <BriefRow
        icon={Play}
        label={translate('missionBrief.row.nextAction', 'Next best action')}
        compact={compact}
      >
        {brief.nextAction.kind === 'known' ? (
          <div className="flex items-center gap-4 rounded-lg border border-border bg-muted/20 px-4 py-3">
            <div className="min-w-0 flex-1">
              <ClaimValue
                testId="mission-brief-next-action"
                className="block text-[15px] font-medium"
              >
                {brief.nextAction.label}
              </ClaimValue>
              <code className="text-[12px] text-muted-foreground">{brief.nextAction.command}</code>
            </div>
            <button
              type="button"
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-[12px] hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              onClick={() =>
                void window.api.ui.writeClipboardText(
                  brief.nextAction.kind === 'known' ? brief.nextAction.command : ''
                )
              }
            >
              <Copy className="size-3.5" aria-hidden />
              {translate('missionBrief.nextAction.copy', 'Copy command')}
            </button>
          </div>
        ) : (
          <ClaimValue testId="mission-brief-next-action">
            {translate('missionBrief.nextAction.unknown', 'Next step unknown')}
          </ClaimValue>
        )}
      </BriefRow>

      <BriefRow
        icon={Link2}
        label={translate('missionBrief.row.unlocks', 'Unlocks')}
        compact={compact}
      >
        <ClaimValue testId="mission-brief-unlocks" className="flex flex-wrap gap-2">
          {brief.unlocks.length > 0
            ? brief.unlocks.map((unlock) => (
                <Chip key={unlock.stageId} icon={Zap}>
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
        compact={compact}
      >
        <ClaimValue testId="mission-brief-intervention" className="flex flex-col gap-1">
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
          compact={compact}
        >
          <ClaimValue testId="mission-brief-delegable" className="flex flex-wrap gap-2">
            {liveWork.length > 0
              ? liveWork.map((work) => (
                  <Chip key={work.missionId} icon={Zap}>
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
        compact={compact}
      >
        <ClaimValue testId="mission-brief-blockers" className="flex flex-col gap-1">
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
          when: formatUiRelativeTime(brief.readAt - Date.now())
        })}
        metaIcon={Clock}
        compact={compact}
      >
        <ClaimValue
          testId="mission-brief-freshness"
          className={cn(
            'inline-flex rounded-md border px-2 py-0.5 text-[13px]',
            MISSION_TONE_CLASS[freshness.tone]
          )}
        >
          {freshness.text}
        </ClaimValue>
      </BriefRow>
    </div>
  )
}
