import type {
  ReplicaPairCompareResult,
  ReplicaPairRelationsResult
} from '../../../shared/replica-pair-view'
import type { RuntimeClientTarget } from './runtime-client-target'

const REMOTE_CALLER_REFUSAL = { status: 'refused', reason: 'remote-caller' } as const

// Why: the pair service spends this desktop's SSH session, so a remote runtime target never reaches it.
function readPairAnswer<T extends ReplicaPairCompareResult | ReplicaPairRelationsResult>(
  answer: unknown,
  closedStatuses: readonly T['status'][]
): T {
  const status = (answer as { status?: unknown } | null | undefined)?.status
  if (!closedStatuses.includes(status as T['status'])) {
    throw new Error(`Unexpected replica pair status: ${String(status)}`)
  }
  if (status === 'ok' && !Array.isArray((answer as { pairs?: unknown }).pairs)) {
    throw new Error('Unexpected replica pair status: ok without pairs')
  }
  return answer as T
}

/** Compare a project's setups with its local anchor on this desktop; a remote target is refused, not forwarded. */
export async function compareReplicaPairs(
  runtimeTarget: RuntimeClientTarget,
  projectId: string,
  setupId?: string
): Promise<ReplicaPairCompareResult> {
  if (runtimeTarget.kind !== 'local') {
    return REMOTE_CALLER_REFUSAL
  }
  const answer = await window.api.replicaPair.compare(
    setupId === undefined ? { projectId } : { projectId, setupId }
  )
  return readPairAnswer<ReplicaPairCompareResult>(answer, [
    'ok',
    'refused',
    'unavailable',
    'not-found'
  ])
}

/** Last published relations for every non-anchor setup; a failure is rethrown, never read as an empty list. */
export async function readReplicaRelations(
  runtimeTarget: RuntimeClientTarget
): Promise<ReplicaPairRelationsResult> {
  if (runtimeTarget.kind !== 'local') {
    return REMOTE_CALLER_REFUSAL
  }
  return readPairAnswer<ReplicaPairRelationsResult>(await window.api.replicaPair.relations(), [
    'ok',
    'refused',
    'unavailable'
  ])
}
