import type { SshConnectionStatus } from '../../../../shared/ssh-types'
import { translate } from '@/i18n/i18n'

export type ReplicaHostHealthState =
  | 'this-host'
  | 'reachable'
  | 'connecting'
  | 'unreachable'
  | 'unknown'

/** Mirrors docs/STYLEGUIDE.md status semantics: HEALTHY, CRITICAL, UNKNOWN. */
export type ReplicaHostHealthTone = 'healthy' | 'critical' | 'unknown'

export type ReplicaHostHealth = {
  state: ReplicaHostHealthState
  tone: ReplicaHostHealthTone
  label: string
}

export type ReplicaHostHealthInput =
  | { hostKind: 'local' }
  | { hostKind: 'ssh'; status: SshConnectionStatus | undefined }
  | {
      hostKind: 'runtime-owned'
      ownerReachable: boolean
      workspaceWindowClosed: boolean
      /** null: the owner could not say; undefined: the host is not reached over SSH. */
      nestedSshStatus: SshConnectionStatus | null | undefined
    }
  | { hostKind: 'unrecognized' }

const TONE_BY_STATE: Record<ReplicaHostHealthState, ReplicaHostHealthTone> = {
  'this-host': 'healthy',
  reachable: 'healthy',
  connecting: 'unknown',
  unreachable: 'critical',
  unknown: 'unknown'
}

function stateOfSshStatus(status: SshConnectionStatus | undefined): ReplicaHostHealthState {
  switch (status) {
    case 'connected':
      return 'reachable'
    case 'connecting':
    case 'deploying-relay':
    case 'reconnecting':
      return 'connecting'
    case 'disconnected':
    case 'auth-failed':
    case 'reconnection-failed':
    case 'error':
      return 'unreachable'
    default:
      // Why: unknown is never healthy (D-15); no entry means the renderer holds no reading.
      return 'unknown'
  }
}

function stateOf(input: ReplicaHostHealthInput): ReplicaHostHealthState {
  switch (input.hostKind) {
    case 'local':
      return 'this-host'
    case 'ssh':
      return stateOfSshStatus(input.status)
    case 'runtime-owned':
      if (!input.ownerReachable || input.workspaceWindowClosed) {
        return 'unreachable'
      }
      if (input.nestedSshStatus === null) {
        return 'unknown'
      }
      return input.nestedSshStatus === undefined || input.nestedSshStatus === 'connected'
        ? 'reachable'
        : 'unreachable'
    case 'unrecognized':
      return 'unknown'
  }
}

function labelOf(state: ReplicaHostHealthState): string {
  switch (state) {
    case 'this-host':
      return translate(
        'auto.components.settings.RepositoryPane.hostHealthThisComputer',
        'This computer'
      )
    case 'reachable':
      return translate('auto.components.settings.RepositoryPane.hostHealthReachable', 'Reachable')
    case 'connecting':
      return translate('auto.components.settings.RepositoryPane.hostStateConnecting', 'Connecting')
    case 'unreachable':
      return translate(
        'auto.components.settings.RepositoryPane.hostStateDisconnected',
        'Disconnected'
      )
    case 'unknown':
      return translate('auto.components.settings.RepositoryPane.hostStateUnknown', 'Unknown')
  }
}

/** The one producer of a replica row's host health; every surface reads it from here. */
export function describeReplicaHostHealth(input: ReplicaHostHealthInput): ReplicaHostHealth {
  const state = stateOf(input)
  // Why: a reachable server whose Orca window is closed is not a lost connection; say so.
  const windowClosed =
    input.hostKind === 'runtime-owned' && input.ownerReachable && input.workspaceWindowClosed
  const label = windowClosed
    ? translate(
        'auto.components.settings.RepositoryPane.hostStateWorkspaceWindowClosed',
        'Workspace window closed'
      )
    : labelOf(state)
  return { state, tone: TONE_BY_STATE[state], label }
}

/** Only these two states let a setup read as ready. */
export function isReplicaHostHealthy(state: ReplicaHostHealthState): boolean {
  return state === 'this-host' || state === 'reachable'
}
