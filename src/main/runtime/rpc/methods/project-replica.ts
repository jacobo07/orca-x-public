import { z } from 'zod'
import type {
  ReplicaCapsuleCreateResult,
  ReplicaCapsuleListResult,
  ReplicaCapsuleRestoreResult
} from '../../../../shared/replica-capsule-view'
import type {
  ReplicaPairCompareResult,
  ReplicaPairRelationsResult
} from '../../../../shared/replica-pair-view'
import type {
  ReplicaPreserveDivergenceResult,
  ReplicaReconcileResult,
  ReplicaSyncResult
} from '../../../../shared/replica-sync-view'
import { readReplicaPairService } from '../../../replica-pair-service-slot'
import { defineMethod, type RpcMethod } from '../core'
import { isLocalRpcCaller } from '../local-rpc-caller'

const SetupParams = z.object({ setupId: z.string().min(1) }).strict()
const RestoreParams = z
  .object({ setupId: z.string().min(1), capsule: z.string().min(1), apply: z.boolean().optional() })
  .strict()
// Why: the service re-validates the sha shape before any git call; the schema only keeps non-strings out.
const ReconcileParams = z
  .object({ setupId: z.string().min(1), remoteCapsule: z.string().min(1) })
  .strict()
const CompareParams = z
  .object({ projectId: z.string().min(1), setupId: z.string().min(1).optional() })
  .strict()

export const PROJECT_REPLICA_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'projectReplica.compare',
    params: CompareParams,
    handler: async (params, ctx): Promise<ReplicaPairCompareResult> => {
      // Why: answering would make this host spend its own SSH credentials on another client's behalf.
      if (!isLocalRpcCaller(ctx)) {
        return { status: 'refused', reason: 'remote-caller' }
      }
      const service = readReplicaPairService()
      if (!service) {
        return { status: 'unavailable', reason: 'no-replica-service' }
      }
      return service.compare(params)
    }
  }),
  defineMethod({
    name: 'projectReplica.relations',
    params: null,
    handler: async (_params, ctx): Promise<ReplicaPairRelationsResult> => {
      // Why: same reason as compare; the stored answers came from this host's SSH session.
      if (!isLocalRpcCaller(ctx)) {
        return { status: 'refused', reason: 'remote-caller' }
      }
      const service = readReplicaPairService()
      return service ? service.relations() : { status: 'unavailable', reason: 'no-replica-service' }
    }
  }),
  defineMethod({
    name: 'projectReplica.capsuleCreate',
    params: SetupParams,
    handler: async (params, ctx): Promise<ReplicaCapsuleCreateResult> => {
      // Why: answering would write capsule refs into this host's worktrees on another client's behalf.
      if (!isLocalRpcCaller(ctx)) {
        return { status: 'refused', reason: 'remote-caller' }
      }
      const service = readReplicaPairService()
      return service
        ? service.capsuleCreate(params)
        : { status: 'unavailable', reason: 'no-replica-service' }
    }
  }),
  defineMethod({
    name: 'projectReplica.capsuleList',
    params: SetupParams,
    handler: async (params, ctx): Promise<ReplicaCapsuleListResult> => {
      // Why: same reason as capsuleCreate; the listing is this host's own refs.
      if (!isLocalRpcCaller(ctx)) {
        return { status: 'refused', reason: 'remote-caller' }
      }
      const service = readReplicaPairService()
      return service
        ? service.capsuleList(params)
        : { status: 'unavailable', reason: 'no-replica-service' }
    }
  }),
  defineMethod({
    name: 'projectReplica.capsuleRestore',
    params: RestoreParams,
    handler: async (params, ctx): Promise<ReplicaCapsuleRestoreResult> => {
      // Why: apply overwrites this host's worktree files, so a remote client may never ask for it.
      if (!isLocalRpcCaller(ctx)) {
        return { status: 'refused', reason: 'remote-caller' }
      }
      const service = readReplicaPairService()
      if (!service) {
        return { status: 'unavailable', reason: 'no-replica-service' }
      }
      // Why: only the boolean true applies; absent or anything else is plan, which changes nothing.
      const mode = params.apply === true ? 'apply' : 'plan'
      return service.capsuleRestore({ setupId: params.setupId, capsule: params.capsule, mode })
    }
  }),
  defineMethod({
    name: 'projectReplica.sync',
    params: SetupParams,
    handler: async (params, ctx): Promise<ReplicaSyncResult> => {
      // Why: sync moves this host's HEAD, so a remote client may never ask for it.
      if (!isLocalRpcCaller(ctx)) {
        return { status: 'refused', reason: 'remote-caller' }
      }
      const service = readReplicaPairService()
      return service
        ? service.sync(params)
        : { status: 'unavailable', reason: 'no-replica-service' }
    }
  }),
  defineMethod({
    name: 'projectReplica.preserveDivergence',
    params: SetupParams,
    handler: async (params, ctx): Promise<ReplicaPreserveDivergenceResult> => {
      // Why: preserving writes refs into this host's repository on another client's behalf.
      if (!isLocalRpcCaller(ctx)) {
        return { status: 'refused', reason: 'remote-caller' }
      }
      const service = readReplicaPairService()
      return service
        ? service.preserveDivergence(params)
        : { status: 'unavailable', reason: 'no-replica-service' }
    }
  }),
  defineMethod({
    name: 'projectReplica.reconcile',
    params: ReconcileParams,
    handler: async (params, ctx): Promise<ReplicaReconcileResult> => {
      // Why: reconcile creates a commit and a ref in this host's repository on another client's behalf.
      if (!isLocalRpcCaller(ctx)) {
        return { status: 'refused', reason: 'remote-caller' }
      }
      const service = readReplicaPairService()
      return service
        ? service.reconcile(params)
        : { status: 'unavailable', reason: 'no-replica-service' }
    }
  })
]
