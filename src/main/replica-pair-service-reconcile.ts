// Reconcile a dirty-both pair into a merge commit under refs/orca/reconciled (row 66): the service half. The local side
// is cut by the one createCapsule; the remote capsule must already be in the anchor's object store. No ref is written
// except the capsule and the reconciled ref, and HEAD, the branch and the working tree are never touched.
import type { ProjectHostSetup } from '../shared/project-types'
import type { ReplicaReconcileResult, ReplicaSyncUnavailable } from '../shared/replica-sync-view'
import { createCapsule, type CapsuleGitRun } from './replica-capsule'
import { localCapsuleGit } from './replica-capsule-git'
import { guarded, locateReplicaTarget } from './replica-pair-service-target'
import { reconcileDirtyBoth, type ReconcileResult } from './replica-reconcile'
import type { GitRun } from './replica-sync'
import type { ReplicaWorktreeMutationGuard } from './replica-worktree-mutation-guard'

// Why: a sha is exactly 40 (sha1) or 64 (sha256) hex digits; the primitive's looser range is not an input contract.
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

type Settled = Exclude<ReplicaReconcileResult, ReplicaSyncUnavailable>

export type ReplicaReconcileOperationDeps = {
  listProjectHostSetups: () => readonly ProjectHostSetup[]
  mutationGuard: ReplicaWorktreeMutationGuard
  git?: GitRun
  capsuleGit?: CapsuleGitRun
}

export type ReplicaReconcileOperations = {
  reconcile(args: { setupId: string; remoteCapsule: string }): Promise<Settled>
}

function viewOf(
  result: ReconcileResult,
  local: { ref: string; omissions: Extract<Settled, { status: 'ok' }>['localOmissions'] }
): Settled {
  if (result.ok) {
    return {
      status: 'ok',
      base: result.base,
      tree: result.tree,
      commit: result.commit,
      ref: result.ref,
      localCapsuleRef: local.ref,
      localOmissions: local.omissions,
      untrackedNotReconciled: result.untrackedNotReconciled
    }
  }
  switch (result.reason) {
    case 'conflict':
      return {
        status: 'failed',
        reason: 'conflict',
        base: result.base,
        conflictedPaths: result.conflictedPaths
      }
    case 'commit-failed':
      return { status: 'failed', reason: 'commit-failed' }
    case 'invalid-input':
    case 'unknown-commit':
    case 'not-same-base':
    case 'merge-tree-unsupported':
      return { status: 'refused', reason: result.reason }
  }
}

export function createReplicaReconcileOperations(
  deps: ReplicaReconcileOperationDeps
): ReplicaReconcileOperations {
  const capsuleGit = deps.capsuleGit ?? localCapsuleGit

  async function run(anchor: ProjectHostSetup, remoteCapsule: string): Promise<Settled> {
    const capsule = await createCapsule(capsuleGit, anchor.path)
    if (capsule.kind === 'clean') {
      return { status: 'refused', reason: 'local-clean' }
    }
    if (capsule.kind === 'refused') {
      return { status: 'refused', reason: capsule.reason }
    }
    return viewOf(
      await reconcileDirtyBoth({
        repoPath: anchor.path,
        localCapsule: capsule.sha,
        remoteCapsule,
        base: capsule.base,
        ...(deps.git ? { git: deps.git } : {})
      }),
      { ref: capsule.ref, omissions: capsule.omissions }
    )
  }

  return {
    async reconcile({ setupId, remoteCapsule }) {
      // Why: a malformed sha is an input error and costs no git call, whatever the setup is.
      if (typeof remoteCapsule !== 'string' || !SHA.test(remoteCapsule)) {
        return { status: 'refused', reason: 'invalid-input' }
      }
      const target = locateReplicaTarget(deps.listProjectHostSetups(), setupId)
      if (!('setup' in target)) {
        return target
      }
      const { anchor } = target
      const ran = await guarded(deps.mutationGuard, anchor.path, () => run(anchor, remoteCapsule))
      return 'done' in ran ? ran.done : ran
    }
  }
}
