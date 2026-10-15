// Capsule create, list and restore for one local git setup (row 64): the service half of the RPC and CLI verbs.
// Create and restore run under the worktree mutation guard; remote and folder setups are refused before any git call.
import { stat } from 'node:fs/promises'
import { parseExecutionHostId } from '../shared/execution-host'
import type { ProjectHostSetup } from '../shared/project-types'
import type {
  ReplicaCapsuleCreateResult,
  ReplicaCapsuleListResult,
  ReplicaCapsuleRestoreResult
} from '../shared/replica-capsule-view'
import { localCapsuleGit } from './replica-capsule-git'
import {
  createCapsule,
  listCapsules,
  type CapsuleGitRun,
  type CapsuleResult
} from './replica-capsule'
import { restoreCapsule, type CapsuleRestoreResult } from './replica-capsule-restore'
import type { ReplicaWorktreeMutationGuard } from './replica-worktree-mutation-guard'

export type ReplicaCapsuleOperationDeps = {
  listProjectHostSetups: () => readonly ProjectHostSetup[]
  /** Production leaves it out and gets the local git runner. */
  capsuleGit?: CapsuleGitRun
  mutationGuard: ReplicaWorktreeMutationGuard
}

type Answered<R> = Exclude<R, { status: 'unavailable' }>

export type ReplicaCapsuleOperations = {
  capsuleCreate(args: { setupId: string }): Promise<Answered<ReplicaCapsuleCreateResult>>
  capsuleList(args: { setupId: string }): Promise<Answered<ReplicaCapsuleListResult>>
  /** Plan unless mode is exactly 'apply'. */
  capsuleRestore(args: {
    setupId: string
    capsule: string
    mode?: 'plan' | 'apply'
  }): Promise<Answered<ReplicaCapsuleRestoreResult>>
}

type Early =
  | { status: 'not-found'; reason: 'unknown-setup' }
  | {
      status: 'refused'
      reason: 'remote-capsule-unsupported' | 'not-a-git-repo' | 'worktree-missing'
    }

type Located = { path: string } | Early

const BUSY = { status: 'refused', reason: 'worktree-busy' } as const
const MISSING = { status: 'refused', reason: 'worktree-missing' } as const

function isRemoteSetup(setup: ProjectHostSetup): boolean {
  // Fail closed: a host id or an owner we cannot read as this machine is not a worktree this process may touch.
  const hosts = [setup.hostId, ...(setup.executionHostId ? [setup.executionHostId] : [])]
  return (
    hosts.some((h) => parseExecutionHostId(h)?.kind !== 'local') ||
    Boolean(setup.runtimeOwnerEnvironmentId)
  )
}

// Why: the host and the kind are classified from the stored setup alone, so a refused setup costs no git call.
async function locate(setups: readonly ProjectHostSetup[], setupId: string): Promise<Located> {
  const setup = setups.find((s) => s.id === setupId)
  if (!setup) {
    return { status: 'not-found', reason: 'unknown-setup' }
  }
  if (isRemoteSetup(setup)) {
    return { status: 'refused', reason: 'remote-capsule-unsupported' }
  }
  if (setup.kind === 'folder') {
    return { status: 'refused', reason: 'not-a-git-repo' }
  }
  const present = await stat(setup.path).then(
    (s) => s.isDirectory(),
    () => false
  )
  return present ? { path: setup.path } : MISSING
}

function createView(result: CapsuleResult): Answered<ReplicaCapsuleCreateResult> {
  switch (result.kind) {
    case 'clean':
      return { status: 'ok', outcome: { kind: 'clean' } }
    case 'refused':
      return { status: 'refused', reason: result.reason }
    case 'created':
      return { status: 'ok', outcome: result }
    default:
      return assertNever(result)
  }
}

function restoreView(result: CapsuleRestoreResult): Answered<ReplicaCapsuleRestoreResult> {
  switch (result.kind) {
    case 'refused':
      return { status: 'refused', reason: result.reason, detail: result.detail }
    case 'plan':
    case 'applied':
      return { status: 'ok', outcome: result }
    case 'failed':
      return {
        status: 'failed',
        reason: result.reason,
        ref: result.ref,
        detail: result.detail,
        recovery: result.recovery
      }
    default:
      return assertNever(result)
  }
}

function assertNever(value: never): never {
  throw new Error(`unhandled capsule result: ${JSON.stringify(value)}`)
}

export function createReplicaCapsuleOperations(
  deps: ReplicaCapsuleOperationDeps
): ReplicaCapsuleOperations {
  const git = deps.capsuleGit ?? localCapsuleGit
  // Why: a failure of the operation itself must surface as itself; only the guard's own realpath failure means "missing".
  async function guarded<T>(
    path: string,
    operation: () => Promise<T>
  ): Promise<{ done: T } | typeof BUSY | typeof MISSING> {
    const failure: { error?: unknown; thrown: boolean } = { thrown: false }
    const outcome = await deps.mutationGuard
      .run(path, async () => {
        try {
          return await operation()
        } catch (error) {
          failure.error = error
          failure.thrown = true
          return undefined
        }
      })
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

  return {
    async capsuleCreate({ setupId }) {
      const located = await locate(deps.listProjectHostSetups(), setupId)
      if (!('path' in located)) {
        return located
      }
      const ran = await guarded(located.path, () => createCapsule(git, located.path))
      return 'done' in ran ? createView(ran.done) : ran
    },

    async capsuleList({ setupId }) {
      const located = await locate(deps.listProjectHostSetups(), setupId)
      if (!('path' in located)) {
        return located
      }
      return { status: 'ok', capsules: await listCapsules(git, located.path) }
    },

    async capsuleRestore({ setupId, capsule, mode }) {
      const located = await locate(deps.listProjectHostSetups(), setupId)
      if (!('path' in located)) {
        return located
      }
      // Why: plan unless the caller said apply in exactly that word; anything else must never write.
      const effective = mode === 'apply' ? 'apply' : 'plan'
      const ran = await guarded(located.path, () =>
        restoreCapsule({ git, worktreePath: located.path, capsule, mode: effective })
      )
      return 'done' in ran ? restoreView(ran.done) : ran
    }
  }
}
