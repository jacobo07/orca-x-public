import type {
  ReplicaPairCompareResult,
  ReplicaPairRelationsResult
} from '../../shared/replica-pair-view'

/** Read-only access to the desktop's replica pair service; no capsule, restore or sync verb is exposed. */
export type ReplicaPairApi = {
  replicaPair: {
    compare: (args: { projectId: string; setupId?: string }) => Promise<ReplicaPairCompareResult>
    relations: () => Promise<ReplicaPairRelationsResult>
  }
}
