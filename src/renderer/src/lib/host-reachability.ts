import type { ExecutionHostKind } from '../../../shared/execution-host'
import type { ExecutionHostHealth } from '../../../shared/execution-host-registry'
import type { SshConnectionStatus } from '../../../shared/ssh-types'
import type { StatusState } from '@/components/ui/status-mark'

/**
 * What Orca has OBSERVED about a host — the one derivation every host-bound surface reads
 * (docs/reference/workspace-workstation.md §2). The registry's `ExecutionHostHealth` answers a
 * different question: whether Orca holds a connection. 'disconnected' is true of a host Orca never
 * tried, so it maps to `unknown`, never to offline; a failed attempt is `failed`, not "down".
 */
export type HostReachability =
  | 'this-machine'
  | 'reachable'
  | 'connecting'
  | 'failed'
  | 'blocked'
  | 'unknown'

export const HOST_REACHABILITIES: readonly HostReachability[] = [
  'this-machine',
  'reachable',
  'connecting',
  'failed',
  'blocked',
  'unknown'
]

export type HostReachabilityEvidence = {
  kind: ExecutionHostKind
  health: ExecutionHostHealth
  connectionStatus?: SshConnectionStatus
}

export type SshConnectionFailure = Extract<
  SshConnectionStatus,
  'auth-failed' | 'error' | 'reconnection-failed'
>

export function isSshConnectionFailure(
  status: SshConnectionStatus | undefined
): status is SshConnectionFailure {
  return status === 'auth-failed' || status === 'error' || status === 'reconnection-failed'
}

export function deriveHostReachability(host: HostReachabilityEvidence): HostReachability {
  if (host.kind === 'local') {
    return 'this-machine'
  }
  if (host.health === 'blocked') {
    return 'blocked'
  }
  if (host.health === 'connecting') {
    return 'connecting'
  }
  if (host.kind === 'ssh') {
    if (host.connectionStatus === 'connected') {
      return 'reachable'
    }
    return isSshConnectionFailure(host.connectionStatus) ? 'failed' : 'unknown'
  }
  // Runtime: 'available' is only reported with a live status (execution-host-registry.ts).
  if (host.health === 'available') {
    return 'reachable'
  }
  return host.health === 'error' ? 'failed' : 'unknown'
}

/** Only an observed host can vouch for what runs on it; every other state leaves that unknown. */
export function hostVouches(reachability: HostReachability): boolean {
  return reachability === 'this-machine' || reachability === 'reachable'
}

/** The STYLEGUIDE system state every surface draws for a reachability; the label names the rest. */
export function hostReachabilityStatus(reachability: HostReachability): StatusState {
  switch (reachability) {
    case 'this-machine':
    case 'reachable':
      return 'HEALTHY'
    case 'connecting':
    case 'blocked':
      return 'PRESSURED'
    case 'failed':
      return 'CRITICAL'
    case 'unknown':
      return 'UNKNOWN'
  }
}
