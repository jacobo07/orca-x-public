import type { ReplicaPairState } from '../../store/slices/replica-pair'
import { translate } from '@/i18n/i18n'

const RELATION_KEY = 'auto.components.settings.RepositoryPane'

export type ReplicaPairNote = {
  state: 'remote-caller' | 'no-replica-service' | 'failed'
  text: string
  /** Whether the Compare action is offered: not when this client can never reach the service. */
  compare: boolean
}

/** The one sentence for a slice state that is not a usable answer; the raw failure message is never copy. */
export function describeReplicaPairState(pair: ReplicaPairState): ReplicaPairNote | null {
  switch (pair.status) {
    case 'idle':
    case 'loading':
    case 'ready':
      return null
    case 'unavailable':
      return pair.reason === 'remote-caller'
        ? {
            state: 'remote-caller',
            compare: false,
            text: translate(
              `${RELATION_KEY}.pairUnavailableRemote`,
              'Replica comparison is not available from this client'
            )
          }
        : {
            state: 'no-replica-service',
            compare: false,
            text: translate(
              `${RELATION_KEY}.pairUnavailableNoService`,
              'Replica comparison is not available: the replica service is not running'
            )
          }
    case 'failed':
      return {
        state: 'failed',
        compare: true,
        text: translate(
          `${RELATION_KEY}.pairFailed`,
          'Could not compare replicas. Relations stay unverified until a comparison succeeds'
        )
      }
  }
}

export function describeReplicaCompareAction(mode: 'idle' | 'comparing'): string {
  return mode === 'comparing'
    ? translate(`${RELATION_KEY}.comparing`, 'Comparing…')
    : translate(`${RELATION_KEY}.compareAction`, 'Compare replicas')
}
