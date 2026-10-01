import {
  getExecutionHostLabel,
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import type { ProjectHostSetup } from '../../../../shared/project-types'
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
  setupReady: boolean
  setupStateLabel: string
  setupHostLabel: string
  runtimeOwnerWorkspaceWindowClosed: boolean
  runtimeOwnerHostLabel: string
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
  const setupReady =
    setup.setupState === 'ready' &&
    runtimeOwnerReachable &&
    !runtimeOwnerWorkspaceWindowClosed &&
    (nestedSshStatus === undefined || nestedSshStatus === 'connected')
  const setupStateLabel = !runtimeOwnerReachable
    ? translate('auto.components.settings.RepositoryPane.hostStateDisconnected', 'Disconnected')
    : runtimeOwnerWorkspaceWindowClosed
      ? translate(
          'auto.components.settings.RepositoryPane.hostStateWorkspaceWindowClosed',
          'Workspace window closed'
        )
      : nestedSshStatus === null
        ? translate('auto.components.settings.RepositoryPane.hostStateUnknown', 'Unknown')
        : nestedSshStatus !== undefined && nestedSshStatus !== 'connected'
          ? translate(
              'auto.components.settings.RepositoryPane.hostStateDisconnected',
              'Disconnected'
            )
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
    setupReady,
    setupStateLabel,
    setupHostLabel,
    runtimeOwnerWorkspaceWindowClosed,
    runtimeOwnerHostLabel
  }
}
