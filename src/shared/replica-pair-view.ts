import type { ExecutionHostId } from './execution-host'
import type { ReplicaRelation } from './workspace-replica-state'

/** One non-anchor setup compared against the project's local anchor setup. */
export type ReplicaPairView = {
  setupId: string
  /** Null only when the project has no local setup to compare against. */
  anchorSetupId: string | null
  hostId: ExecutionHostId
  /** The anchor's relation to this setup: `ahead` means the anchor holds commits this setup lacks. */
  relation: ReplicaRelation
  /** True only for a verified-clean `same` pair (isReplicaRelationHealthy); unknown is never healthy. */
  healthy: boolean
  /** The setup's tip as observed by the comparison; absent when no comparison reached the host. */
  remoteTip?: string
}

export type ReplicaPairCompareResult =
  | { status: 'ok'; pairs: ReplicaPairView[] }
  | { status: 'refused'; reason: 'remote-caller' }
  | { status: 'unavailable'; reason: 'no-replica-service' }
  | { status: 'not-found'; reason: 'unknown-project' | 'unknown-setup' }
