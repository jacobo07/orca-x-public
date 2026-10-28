import type {
  ReplicaCapsuleCreateResult,
  ReplicaCapsuleListResult,
  ReplicaCapsuleRestoreResult
} from '../../shared/replica-capsule-view'
import type { ReplicaPairCompareResult } from '../../shared/replica-pair-view'
import type {
  ReplicaPreserveDivergenceResult,
  ReplicaReconcileResult,
  ReplicaSyncResult
} from '../../shared/replica-sync-view'
import type { CommandHandler, HandlerContext } from '../dispatch'
import { getOptionalStringFlag, getRequiredStringFlag } from '../flags'
import { printResult } from '../format'
import {
  formatReplicaCapsuleCreate,
  formatReplicaCapsuleList,
  formatReplicaCapsuleRestore,
  formatReplicaCompare
} from '../project-replica-format'
import {
  formatReplicaPreserveDivergence,
  formatReplicaReconcile,
  formatReplicaSync
} from '../project-replica-sync-format'
import { REPLICA_RECONCILE_USAGE } from '../specs/project-replica'
import {
  RuntimeClientError,
  RuntimeRpcFailureError,
  type RuntimeRpcSuccess
} from '../runtime-client'

async function callReplica<T>(
  client: HandlerContext['client'],
  method: string,
  params: Record<string, unknown>,
  feature: string
): Promise<RuntimeRpcSuccess<T>> {
  try {
    return await client.call<T>(method, params)
  } catch (error) {
    // Why: a new RPC name fails closed on an old host, and that must not read as "no replicas".
    if (error instanceof RuntimeRpcFailureError && error.code === 'method_not_found') {
      throw new RuntimeClientError(
        'update_required',
        `this Orca host predates replica ${feature}; update the host`
      )
    }
    throw error
  }
}

export const PROJECT_REPLICA_HANDLERS: Record<string, CommandHandler> = {
  'project replica-compare': async ({ client, flags, json }) => {
    const projectId = getRequiredStringFlag(flags, 'project')
    const setupId = getOptionalStringFlag(flags, 'setup')
    const response = await callReplica<ReplicaPairCompareResult>(
      client,
      'projectReplica.compare',
      { projectId, ...(setupId ? { setupId } : {}) },
      'compare'
    )
    process.exitCode = formatReplicaCompare(response.result).exitCode
    printResult(response, json, (result) => formatReplicaCompare(result).text)
  },

  'project replica-capsule': async ({ client, flags, json }) => {
    const setupId = getRequiredStringFlag(flags, 'setup')
    const response = await callReplica<ReplicaCapsuleCreateResult>(
      client,
      'projectReplica.capsuleCreate',
      { setupId },
      'capsules'
    )
    process.exitCode = formatReplicaCapsuleCreate(response.result, setupId).exitCode
    printResult(response, json, (result) => formatReplicaCapsuleCreate(result, setupId).text)
  },

  'project replica-capsule-list': async ({ client, flags, json }) => {
    const setupId = getRequiredStringFlag(flags, 'setup')
    const response = await callReplica<ReplicaCapsuleListResult>(
      client,
      'projectReplica.capsuleList',
      { setupId },
      'capsules'
    )
    process.exitCode = formatReplicaCapsuleList(response.result, setupId).exitCode
    printResult(response, json, (result) => formatReplicaCapsuleList(result, setupId).text)
  },

  'project replica-capsule-restore': async ({ client, flags, json }) => {
    const setupId = getRequiredStringFlag(flags, 'setup')
    const capsule = getRequiredStringFlag(flags, 'capsule')
    // Why: apply is sent only for the explicit flag; the default request can never write.
    const apply = flags.get('apply') === true
    const response = await callReplica<ReplicaCapsuleRestoreResult>(
      client,
      'projectReplica.capsuleRestore',
      { setupId, capsule, ...(apply ? { apply: true } : {}) },
      'capsules'
    )
    process.exitCode = formatReplicaCapsuleRestore(response.result, setupId).exitCode
    printResult(response, json, (result) => formatReplicaCapsuleRestore(result, setupId).text)
  },

  'project replica-sync': async ({ client, flags, json }) => {
    const setupId = getRequiredStringFlag(flags, 'setup')
    const response = await callReplica<ReplicaSyncResult>(
      client,
      'projectReplica.sync',
      { setupId },
      'sync'
    )
    process.exitCode = formatReplicaSync(response.result, setupId).exitCode
    printResult(response, json, (result) => formatReplicaSync(result, setupId).text)
  },

  'project replica-preserve-divergence': async ({ client, flags, json }) => {
    const setupId = getRequiredStringFlag(flags, 'setup')
    const response = await callReplica<ReplicaPreserveDivergenceResult>(
      client,
      'projectReplica.preserveDivergence',
      { setupId },
      'sync'
    )
    process.exitCode = formatReplicaPreserveDivergence(response.result, setupId).exitCode
    printResult(response, json, (result) => formatReplicaPreserveDivergence(result, setupId).text)
  },

  'project replica-reconcile': async ({ client, flags, json }) => {
    const setupId = getRequiredStringFlag(flags, 'setup')
    const remoteCapsule = flags.get('remote-capsule')
    if (typeof remoteCapsule !== 'string' || remoteCapsule.length === 0) {
      throw new RuntimeClientError(
        'invalid_argument',
        `Missing required --remote-capsule\nUsage: ${REPLICA_RECONCILE_USAGE}`
      )
    }
    // Why: the value is forwarded as an opaque string; the host validates its shape before any git call.
    const response = await callReplica<ReplicaReconcileResult>(
      client,
      'projectReplica.reconcile',
      { setupId, remoteCapsule },
      'sync'
    )
    process.exitCode = formatReplicaReconcile(response.result, setupId, remoteCapsule).exitCode
    printResult(
      response,
      json,
      (result) => formatReplicaReconcile(result, setupId, remoteCapsule).text
    )
  }
}
