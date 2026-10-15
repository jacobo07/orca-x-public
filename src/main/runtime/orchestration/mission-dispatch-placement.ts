import { LOCAL_EXECUTION_HOST_ID, toRuntimeExecutionHostId } from '../../../shared/execution-host'
import type { FleetPlacementMember, FleetPlacementRequest } from '../../../shared/fleet-placement'
import type { NodeRequirement } from '../../../shared/node-manifest-eligibility'
import {
  planMissionPlacement,
  type MissionPlacementPlan
} from '../../../shared/mission-job-placement'
import {
  ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY,
  ORCHESTRATION_FEDERATION_RUNTIME_CAPABILITY
} from '../../../shared/protocol-version'
import { OrchestrationError } from './orchestration-error'
import type { DispatchContextRow, FederatedDispatchRow, TaskPlacementRow } from './types'

export type NotDispatchableMember = { address: string; label: string; reason: 'not-dispatchable' }

/** Only this host and federation-capable paired runtimes can run a worker; a relay never can. */
export function isDispatchableMember(member: FleetPlacementMember): boolean {
  if (member.address === LOCAL_EXECUTION_HOST_ID) {
    return true
  }
  const capabilities = member.facts.capabilities ?? []
  return (
    member.address.startsWith('runtime:') &&
    capabilities.includes(ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY) &&
    capabilities.includes(ORCHESTRATION_FEDERATION_RUNTIME_CAPABILITY)
  )
}

export type DispatchableMissionOptions = {
  /** Per-task resource need keyed by task id; a task with no entry inherits the request's. */
  requirements?: Readonly<Record<string, NodeRequirement>>
}

export function planDispatchableMission(
  taskIds: readonly string[],
  members: readonly FleetPlacementMember[],
  request: FleetPlacementRequest,
  options: DispatchableMissionOptions = {}
): MissionPlacementPlan & { notDispatchable: NotDispatchableMember[] } {
  const dispatchable = members.filter(isDispatchableMember)
  const notDispatchable = members
    .filter((m) => !isDispatchableMember(m))
    .map((m) => ({ address: m.address, label: m.label, reason: 'not-dispatchable' as const }))
  const plan = planMissionPlacement(
    taskIds.map((jobId) => ({ jobId, requirement: options.requirements?.[jobId] })),
    dispatchable,
    request
  )
  return { ...plan, notDispatchable }
}

/** A completion counts for a placement only if its dispatch really ran on that host. */
export function dispatchRanOnPlacement(
  placement: TaskPlacementRow,
  dispatch: DispatchContextRow | undefined,
  federated: FederatedDispatchRow | undefined
): boolean {
  if (!dispatch) {
    return false
  }
  if (placement.address === LOCAL_EXECUTION_HOST_ID) {
    return !federated
  }
  return (
    federated !== undefined &&
    toRuntimeExecutionHostId(federated.environment_id) === placement.address &&
    federated.peer_fingerprint === placement.fingerprint
  )
}

/**
 * Refuses before any dispatch row exists when a placed task is started anywhere but its placement.
 * `remote` is the resolved server for `on`; its fingerprint is re-read at the effect, not trusted from the plan.
 */
export function assertWorkerStartMatchesPlacement(
  placement: TaskPlacementRow | undefined,
  remote: { environmentId: string; peerFingerprint: string } | null
): void {
  if (!placement) {
    return
  }
  const requested = remote
    ? toRuntimeExecutionHostId(remote.environmentId)
    : LOCAL_EXECUTION_HOST_ID
  if (requested !== placement.address) {
    throw new OrchestrationError(
      'placement_mismatch',
      `Task ${placement.task_id} is placed on ${placement.label} (${placement.address}), not ${requested}.`,
      { taskId: placement.task_id, placedAddress: placement.address, requestedAddress: requested }
    )
  }
  if (remote && remote.peerFingerprint !== placement.fingerprint) {
    throw new OrchestrationError(
      'placement_mismatch',
      `Task ${placement.task_id}: ${placement.label} no longer presents the key it was placed by.`,
      { taskId: placement.task_id, reason: 'peer-fingerprint-changed' }
    )
  }
}
