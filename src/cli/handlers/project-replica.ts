import type { ReplicaPairCompareResult } from '../../shared/replica-pair-view'
import type { CommandHandler, HandlerContext } from '../dispatch'
import { getOptionalStringFlag, getRequiredStringFlag } from '../flags'
import { printResult } from '../format'
import { formatReplicaCompare } from '../project-replica-format'
import {
  RuntimeClientError,
  RuntimeRpcFailureError,
  type RuntimeRpcSuccess
} from '../runtime-client'

async function callCompare(
  client: HandlerContext['client'],
  params: { projectId: string; setupId?: string }
): Promise<RuntimeRpcSuccess<ReplicaPairCompareResult>> {
  try {
    return await client.call<ReplicaPairCompareResult>('projectReplica.compare', params)
  } catch (error) {
    // Why: a new RPC name fails closed on an old host, and that must not read as "no replicas".
    if (error instanceof RuntimeRpcFailureError && error.code === 'method_not_found') {
      throw new RuntimeClientError(
        'update_required',
        'this Orca host predates replica compare; update the host'
      )
    }
    throw error
  }
}

export const PROJECT_REPLICA_HANDLERS: Record<string, CommandHandler> = {
  'project replica-compare': async ({ client, flags, json }) => {
    const projectId = getRequiredStringFlag(flags, 'project')
    const setupId = getOptionalStringFlag(flags, 'setup')
    const response = await callCompare(client, { projectId, ...(setupId ? { setupId } : {}) })
    process.exitCode = formatReplicaCompare(response.result).exitCode
    printResult(response, json, (result) => formatReplicaCompare(result).text)
  }
}
