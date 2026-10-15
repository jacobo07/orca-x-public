// What the pair service decides from the stored setups alone, before any git or relay call: which setup, which local
// anchor worktree it would change, and whether the per-worktree mutation guard lets the operation start.
import { parseExecutionHostId } from '../shared/execution-host'
import type { ProjectHostSetup } from '../shared/project-types'
import type { ReplicaSyncNotFound, ReplicaSyncRefusal } from '../shared/replica-sync-view'
import { pickAnchor } from './replica-pair-views'
import type { ReplicaWorktreeMutationGuard } from './replica-worktree-mutation-guard'

export const BUSY = { status: 'refused', reason: 'worktree-busy' } as const
export const MISSING = { status: 'refused', reason: 'worktree-missing' } as const

export function isRemoteSetup(setup: ProjectHostSetup): boolean {
  // Fail closed: a host id or an owner we cannot read as this machine is not a worktree this process may touch.
  const hosts = [setup.hostId, ...(setup.executionHostId ? [setup.executionHostId] : [])]
  return (
    hosts.some((h) => parseExecutionHostId(h)?.kind !== 'local') ||
    Boolean(setup.runtimeOwnerEnvironmentId)
  )
}

export type ReplicaTarget = {
  /** The remote replica the operation compares against. */
  setup: ProjectHostSetup
  /** The local anchor: the only worktree an operation may change. */
  anchor: ProjectHostSetup
  connectionId: string
}

export type ReplicaTargetRefusal =
  | ReplicaSyncNotFound
  | {
      status: 'refused'
      reason: Extract<
        ReplicaSyncRefusal,
        'no-local-anchor' | 'anchor-setup' | 'remote-runtime-unsupported' | 'not-a-git-repo'
      >
    }

const refuse = (
  reason: Extract<ReplicaTargetRefusal, { status: 'refused' }>['reason']
): ReplicaTargetRefusal => ({
  status: 'refused',
  reason
})

export function locateReplicaTarget(
  setups: readonly ProjectHostSetup[],
  setupId: string
): ReplicaTarget | ReplicaTargetRefusal {
  const setup = setups.find((s) => s.id === setupId)
  if (!setup) {
    return { status: 'not-found', reason: 'unknown-setup' }
  }
  const anchor = pickAnchor(setups.filter((s) => s.projectId === setup.projectId))
  if (!anchor) {
    return refuse('no-local-anchor')
  }
  // A setup on this machine is never the replica: there is nothing to fetch it from.
  if (setup.id === anchor.id || parseExecutionHostId(setup.hostId)?.kind === 'local') {
    return refuse('anchor-setup')
  }
  const parsed = parseExecutionHostId(setup.hostId)
  if (parsed?.kind !== 'ssh' || isRemoteSetup(anchor) || setup.runtimeOwnerEnvironmentId) {
    return refuse('remote-runtime-unsupported')
  }
  if (setup.kind === 'folder' || anchor.kind === 'folder') {
    return refuse('not-a-git-repo')
  }
  return { setup, anchor, connectionId: setup.connectionId ?? parsed.targetId }
}

/**
 * Runs the operation under the worktree guard. Busy and a worktree that cannot be resolved are answers; a failure of
 * the operation itself is the operation's own error and surfaces as itself.
 */
export async function guarded<T>(
  guard: ReplicaWorktreeMutationGuard,
  path: string,
  operation: () => Promise<T>
): Promise<{ done: T } | typeof BUSY | typeof MISSING> {
  const failure: { error?: unknown; thrown: boolean } = { thrown: false }
  const outcome = await guard
    .run(path, async () => {
      try {
        return await operation()
      } catch (error) {
        failure.error = error
        failure.thrown = true
        return undefined
      }
    })
    // Why: only the guard's own realpath failure means "missing"; the operation's errors were captured above.
    .catch(() => null)
  if (outcome === null) {
    return MISSING
  }
  if (outcome.kind === 'busy') {
    return BUSY
  }
  if (failure.thrown) {
    throw failure.error
  }
  return { done: outcome.value as T }
}
