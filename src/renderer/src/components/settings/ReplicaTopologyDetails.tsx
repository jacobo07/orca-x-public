import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { ReplicaTopologyEntry } from '../../../../shared/replica-topology'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { ProjectReplicaNotice } from '../../store/replica-topology-selector'
import { ContextRow } from '../conversations/AgentContextRail'
import type { ReplicaHostHealth, ReplicaHostHealthTone } from './replica-host-health-presentation'
import {
  describeGroupingEvidence,
  describeReplicaMembership,
  describeReplicaMembershipReason,
  describeReplicaProvenance,
  describeReplicaRelation,
  type ReplicaRelationDescription,
  type ReplicaRelationTone
} from './replica-topology-presentation'
import { SettingsBadge } from './SettingsFormControls'

const REPLICA_HOST_HEALTH_TONE_CLASS: Record<ReplicaHostHealthTone, string> = {
  healthy: 'text-status-success',
  critical: 'text-status-error',
  unknown: 'text-status-unknown'
}

const REPLICA_RELATION_TONE_CLASS: Record<ReplicaRelationTone, string> = {
  healthy: 'text-status-success',
  pressured: 'text-status-warning',
  critical: 'text-status-error',
  unknown: 'text-status-unknown'
}

function healthLabel(health: ReplicaHostHealth): string {
  // Why: the gate requires the consumer to render its own unknown state, never a borrowed one.
  return health.state === 'unknown'
    ? translate('auto.components.settings.RepositoryPane.hostStateUnknown', 'Unknown')
    : health.label
}

/** Where a replica's host stands, beside the replica; the state word is the carrier, not the colour. */
export function ReplicaHostHealthLine({
  health
}: {
  health: ReplicaHostHealth
}): React.JSX.Element {
  return (
    <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-2 text-[11px]">
      <ContextRow
        term={translate('auto.components.settings.RepositoryPane.replicaHostHealth', 'Host')}
        testId="replica-host-health"
        state={health.state}
      >
        <span
          data-replica-host-health={health.state}
          className={REPLICA_HOST_HEALTH_TONE_CLASS[health.tone]}
        >
          {healthLabel(health)}
        </span>
      </ContextRow>
    </dl>
  )
}

function relationLabel(described: ReplicaRelationDescription): string {
  // Why: the gate requires the consumer to render its own unknown state, never a borrowed one.
  return described.state === 'unverified'
    ? translate('auto.components.settings.RepositoryPane.relationUnverified', 'Relation unverified')
    : described.text
}

/** The pair service's published relation; the label carries it, the mark and colour only reinforce it. */
function ReplicaRelationLine({ entry }: { entry: ReplicaTopologyEntry }): React.JSX.Element {
  const described = describeReplicaRelation(entry)
  return (
    <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-2 text-[11px]">
      <ContextRow
        term={translate('auto.components.settings.RepositoryPane.relationTerm', 'Relation')}
        testId="replica-relation"
        state={described.state}
      >
        <span
          data-replica-relation={described.state}
          data-replica-relation-tone={described.tone}
          className={cn(
            'inline-flex items-center gap-1.5',
            REPLICA_RELATION_TONE_CLASS[described.tone]
          )}
        >
          <span
            aria-hidden
            data-replica-relation-mark
            className={cn(
              'size-1.5 shrink-0 rounded-full',
              // Why: unknown is the hollow dot where every other tone is filled (STYLEGUIDE).
              described.tone === 'unknown' ? 'border border-current bg-transparent' : 'bg-current'
            )}
          />
          {relationLabel(described)}
        </span>
        {described.detail ? (
          <p className="text-muted-foreground" data-replica-relation-detail>
            {described.detail}
          </p>
        ) : null}
      </ContextRow>
    </dl>
  )
}

/** How a replica came to exist and how it belongs to its project; plain text, nothing hover-only. */
export function ReplicaRowTopology({
  entry
}: {
  entry: ReplicaTopologyEntry | undefined
}): React.JSX.Element {
  if (!entry) {
    // Why: no producer answer is an unknown, never a silent blank (D-15).
    return (
      <div className="mt-1" data-replica-membership="identity-pending">
        <p className="text-[11px] text-muted-foreground">
          {describeReplicaMembershipReason('host-not-reporting')}
        </p>
      </div>
    )
  }
  const provenance = describeReplicaProvenance(entry.provenance)
  const membership = describeReplicaMembership(entry.membership)
  const reason = describeReplicaMembershipReason(entry.membershipReason)
  return (
    <div
      className="mt-1 space-y-0.5"
      data-replica-membership={entry.membership}
      data-replica-provenance={entry.provenance}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <SettingsBadge tone={provenance.tone}>{provenance.text}</SettingsBadge>
        <SettingsBadge tone={membership.tone}>{membership.text}</SettingsBadge>
      </div>
      {entry.relation ? <ReplicaRelationLine entry={entry} /> : null}
      {reason ? <p className="text-[11px] text-muted-foreground">{reason}</p> : null}
    </div>
  )
}

/** Project-level facts: what grouped the copies, and the copies that were kept apart. */
export function ReplicaTopologyNotice({
  notice,
  hostLabelOf
}: {
  notice: ProjectReplicaNotice
  hostLabelOf: (hostId: ExecutionHostId) => string
}): React.JSX.Element | null {
  if (!notice.groupingRootCommit && notice.collisions.length === 0) {
    return null
  }
  return (
    <div className="space-y-2 text-[11px] text-muted-foreground">
      {notice.groupingRootCommit ? (
        <p data-replica-grouping-evidence="true">
          {describeGroupingEvidence(notice.groupingRootCommit)}
        </p>
      ) : null}
      {notice.collisions.length > 0 ? (
        <div className="space-y-1" data-replica-collisions="true">
          <p className="font-medium text-foreground">
            {translate(
              'auto.components.settings.RepositoryPane.collisionsTitle',
              'Other copies with the same first commit'
            )}
          </p>
          <p>
            {translate(
              'auto.components.settings.RepositoryPane.collisionsHelp',
              'These repositories share a first commit but were not grouped with this project, because they may be different repositories.'
            )}
          </p>
          <ul className="space-y-0.5">
            {notice.collisions.map((replica) => (
              <li
                key={`${replica.kind}:${replica.setupId}`}
                data-replica-membership="colliding"
                className="flex min-w-0 flex-wrap gap-x-2"
              >
                <span className="font-medium text-foreground">{hostLabelOf(replica.hostId)}</span>
                <span className="min-w-0 truncate font-mono">{replica.path}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}
