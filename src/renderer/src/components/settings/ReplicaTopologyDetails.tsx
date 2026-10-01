import { translate } from '@/i18n/i18n'
import { ContextRow } from '../conversations/AgentContextRail'
import type { ReplicaHostHealth, ReplicaHostHealthTone } from './replica-host-health-presentation'

const REPLICA_HOST_HEALTH_TONE_CLASS: Record<ReplicaHostHealthTone, string> = {
  healthy: 'text-status-success',
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
