import { z } from 'zod'
import type { ReplicaPairCompareResult } from '../../../../shared/replica-pair-view'
import { readReplicaPairService } from '../../../replica-pair-service-slot'
import { defineMethod, type RpcMethod } from '../core'
import { isLocalRpcCaller } from '../local-rpc-caller'

const CompareParams = z.object({ projectId: z.string().min(1), setupId: z.string().min(1).optional() }).strict()

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
  })
]
