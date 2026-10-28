import {
  getExecutionHostLabel,
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import type { ProjectHostSetup } from '../../../../shared/project-types'
import type { SshConnectionStatus } from '../../../../shared/ssh-types'
import { translate } from '@/i18n/i18n'
import {
  isConnectedRuntimeHostState,
  runtimeHostConnectionState
} from '@/runtime/runtime-host-connection-state'
import {
  selectRuntimeAwareSshStatus,
  selectRuntimeAwareSshTargetLabel
} from '@/store/slices/runtime-environment-ssh'
import type { AppState } from '@/store/types'
import { getSetupStateLabel } from './repository-host-setup-options'
import {
  describeReplicaHostHealth,
  isReplicaHostHealthy,
  type ReplicaHostHealth,
  type ReplicaHostHealthInput
} from './replica-host-health-presentation'

export type RepositoryHostSetupRowStateStore = Pick<
  AppState,
  | 'sshConnectionStates'
  | 'sshTargetLabels'
  | 'removedSshTargetLabels'
  | 'sshTargetsHydrated'
  | 'sshStateByEnvironment'
  | 'runtimeStatusByEnvironmentId'
>

export type RepositoryHostSetupRowState = {
  health: ReplicaHostHealth
  setupReady: boolean
  setupStateLabel: string
  setupHostLabel: string
  runtimeOwnerWorkspaceWindowClosed: boolean
  runtimeOwnerHostLabel: string
}

function healthInputOf({
  executionHost,
  runtimeOwned,
  runtimeOwnerReachable,
  runtimeOwnerWorkspaceWindowClosed,
  nestedSshStatus,
  directSshStatus
}: {
  executionHost: ReturnType<typeof parseExecutionHostId>
  runtimeOwned: boolean
  runtimeOwnerReachable: boolean
  runtimeOwnerWorkspaceWindowClosed: boolean
  nestedSshStatus: SshConnectionStatus | null | undefined
  directSshStatus: SshConnectionStatus | undefined
}): ReplicaHostHealthInput {
  if (runtimeOwned) {
    return {
      hostKind: 'runtime-owned',
      ownerReachable: runtimeOwnerReachable,
      workspaceWindowClosed: runtimeOwnerWorkspaceWindowClosed,
      nestedSshStatus
    }
  }
  if (executionHost?.kind === 'local') {
    return { hostKind: 'local' }
  }
  if (executionHost?.kind === 'ssh') {
    return { hostKind: 'ssh', status: directSshStatus }
  }
  return { hostKind: 'unrecognized' }
}

/** Per-row host label, readiness and badge text of the Settings > Available Hosts list. */
export function deriveRepositoryHostSetupRowState({
  setup,
  hostOptionById,
  store
}: {
  setup: ProjectHostSetup
  hostOptionById: ReadonlyMap<string, { label: string }>
  store: RepositoryHostSetupRowStateStore
}): RepositoryHostSetupRowState {
  const executionHost = parseExecutionHostId(setup.executionHostId ?? setup.hostId)
  const transportHost = parseExecutionHostId(setup.hostId)
  const runtimeOwnerEnvironmentId =
    setup.runtimeOwnerEnvironmentId?.trim() ||
    (transportHost?.kind === 'runtime' ? transportHost.environmentId : null)
  // Why: share one host-health derivation with the status bar so a degraded
  // owner can never read "Ready" here and "Connected"/"Disconnected" there.
  const runtimeOwnerStatusEntry = runtimeOwnerEnvironmentId
    ? store.runtimeStatusByEnvironmentId.get(runtimeOwnerEnvironmentId)
    : undefined
  const runtimeOwnerState = runtimeOwnerEnvironmentId
    ? runtimeHostConnectionState({
        hasStatusEntry: Boolean(runtimeOwnerStatusEntry),
        status: runtimeOwnerStatusEntry?.status
      })
    : null
  const runtimeOwnerReachable =
    runtimeOwnerState === null || isConnectedRuntimeHostState(runtimeOwnerState)
  const runtimeOwnerWorkspaceWindowClosed = runtimeOwnerState === 'workspace-window-closed'
  const runtimeOwnerHostId: ExecutionHostId | null = runtimeOwnerEnvironmentId
    ? toRuntimeExecutionHostId(runtimeOwnerEnvironmentId)
    : null
  const runtimeOwnerHostLabel = runtimeOwnerHostId
    ? (hostOptionById.get(runtimeOwnerHostId)?.label ?? getExecutionHostLabel(runtimeOwnerHostId))
    : ''
  const nestedSshStatus =
    runtimeOwnerEnvironmentId && executionHost?.kind === 'ssh'
      ? selectRuntimeAwareSshStatus(store, runtimeOwnerEnvironmentId, executionHost.targetId)
      : undefined
  const health = describeReplicaHostHealth(
    healthInputOf({
      executionHost,
      runtimeOwned: runtimeOwnerEnvironmentId !== null,
      runtimeOwnerReachable,
      runtimeOwnerWorkspaceWindowClosed,
      nestedSshStatus,
      directSshStatus:
        executionHost?.kind === 'ssh'
          ? store.sshConnectionStates.get(executionHost.targetId)?.status
          : undefined
    })
  )
  // Why: a setup is never "Ready" on a host that is not known to be reachable (D-15).
  const setupReady = setup.setupState === 'ready' && isReplicaHostHealthy(health.state)
  // Why: a setup that is itself not ready keeps its own state word on a directly reached host;
  // the host word replaces it only where the host is what decides (runtime-owned rows, ready rows).
  const hostWordDecides = runtimeOwnerEnvironmentId !== null || setup.setupState === 'ready'
  const setupStateLabel =
    hostWordDecides && !isReplicaHostHealthy(health.state)
      ? health.label
      : getSetupStateLabel(setup.setupState)
  const setupHostLabel =
    runtimeOwnerEnvironmentId && executionHost?.kind === 'ssh'
      ? translate(
          'auto.components.settings.RepositoryPane.nestedHostLabel',
          '{{value0}} via {{value1}}',
          {
            value0: selectRuntimeAwareSshTargetLabel(
              store,
              runtimeOwnerEnvironmentId,
              executionHost.targetId
            ),
            value1: hostOptionById.get(setup.hostId)?.label ?? getExecutionHostLabel(setup.hostId)
          }
        )
      : (hostOptionById.get(setup.hostId)?.label ?? getExecutionHostLabel(setup.hostId))
  return {
    health,
    setupReady,
    setupStateLabel,
    setupHostLabel,
    runtimeOwnerWorkspaceWindowClosed,
    runtimeOwnerHostLabel
  }
}
