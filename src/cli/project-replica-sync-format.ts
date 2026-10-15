import type {
  ReplicaPreserveDivergenceResult,
  ReplicaReconcileRefusal,
  ReplicaReconcileResult,
  ReplicaSyncRefusal,
  ReplicaSyncResult
} from '../shared/replica-sync-view'
import { unreachable, type ReplicaCommandOutput } from './project-replica-format'

const SHORT = 7
const short = (sha: string): string => sha.slice(0, SHORT)
const plural = (count: number, one: string, many: string): string => (count === 1 ? one : many)

const LOST = 'the connection to the host was lost or its relay is unavailable'

// Why: a Record over the closed union, so a new refusal word is a type error here and not a bare word on a terminal.
const REFUSAL_SENTENCE: Record<ReplicaSyncRefusal, (setupId: string) => string> = {
  'remote-caller': () => 'only this machine may run replica operations.',
  'no-local-anchor': () => 'this project has no setup on this machine to work against.',
  'anchor-setup': (setupId) =>
    `setup ${setupId} is the local anchor itself; pass the SSH replica's setup id.`,
  'remote-runtime-unsupported': (setupId) =>
    `setup ${setupId} is owned by a remote runtime; this command works on SSH replicas of a local anchor.`,
  'not-a-git-repo': (setupId) => `setup ${setupId} is not a git repository.`,
  'worktree-missing': () => 'the local worktree directory does not exist.',
  'worktree-busy': () =>
    'another replica operation is running on this worktree; try again when it finishes.'
}

function refusalLine(command: string, reason: ReplicaSyncRefusal, setupId: string): string {
  return `${command}: refused (${reason}) — ${REFUSAL_SENTENCE[reason](setupId)}`
}

function unavailableLine(command: string, reason: string): ReplicaCommandOutput {
  return {
    text: `${command}: unavailable (${reason}) — this host has no replica service.`,
    exitCode: 1
  }
}

function notFoundLine(command: string, reason: string): ReplicaCommandOutput {
  return { text: `${command}: not found (${reason}).`, exitCode: 1 }
}

function capsuleNote(capsuleRef: string | undefined): string[] {
  return capsuleRef ? [`previous state saved as ${capsuleRef}`] : []
}

/** Sync: only an ok result exits 0; a full disk, a lost connection and a stale generation read differently. */
export function formatReplicaSync(
  result: ReplicaSyncResult,
  setupId: string
): ReplicaCommandOutput {
  switch (result.status) {
    case 'ok':
      return {
        text: `synced ${short(result.from)}..${short(result.to)}; ${
          result.capsuleRef
            ? `previous state saved as ${result.capsuleRef}`
            : 'there was no uncommitted work to save'
        }`,
        exitCode: 0
      }
    case 'failed':
      return { text: syncFailureLines(result).join('\n'), exitCode: 1 }
    case 'refused':
      return { text: refusalLine('replica-sync', result.reason, setupId), exitCode: 1 }
    case 'unavailable':
      return unavailableLine('replica-sync', result.reason)
    case 'not-found':
      return notFoundLine('replica-sync', result.reason)
    default:
      return unreachable(result)
  }
}

function syncFailureLines(result: Extract<ReplicaSyncResult, { status: 'failed' }>): string[] {
  const note = capsuleNote(result.capsuleRef)
  if (result.cause === 'disk-full') {
    return ['sync failed: the local disk is full; HEAD was not moved', ...note]
  }
  switch (result.reason) {
    case 'stale-generation':
      return ['sync failed: the connection changed during the sync; run it again', ...note]
    case 'operation-in-progress':
      return [
        'sync refused: a rebase, merge, cherry-pick, revert or bisect is in progress in the local worktree; HEAD was not moved',
        'finish or abort it, then run the sync again'
      ]
    case 'compare-transfer-interrupted':
      return [
        `sync failed: ${LOST}; HEAD was not moved`,
        'the transfer was interrupted; run it again'
      ]
    case 'compare-relay-unsupported':
      return [
        `sync failed: ${LOST}; HEAD was not moved`,
        'check that the SSH connection is up and that the relay on the host is current'
      ]
    case 'not-behind':
      return [`nothing to sync: the replica is ${result.observedAncestry ?? 'not behind'}`]
    case 'verify-failed':
      // Why: the merge ran and HEAD is not at the remote tip, so "HEAD was not moved" would be false.
      return [
        'sync failed: verify-failed; HEAD is not at the remote tip; check git status',
        ...note
      ]
    case 'ff-failed':
      // Why: a fast-forward that failed midway can leave the working tree partly updated.
      return [
        'sync failed: ff-failed; HEAD was not moved',
        'the merge did not complete; check git status',
        ...note
      ]
    default:
      return [`sync failed: ${result.reason}; HEAD was not moved`, ...note]
  }
}

function preserveFailureText(
  result: Extract<ReplicaPreserveDivergenceResult, { status: 'failed' }>
): string {
  const head = 'replica-preserve-divergence failed:'
  if (result.cause === 'disk-full') {
    return `${head} the local disk is full`
  }
  return result.reason === 'compare-transfer-interrupted'
    ? `${head} ${LOST}`
    : `${head} ${result.reason}`
}

function conflictLines(
  conflict: Extract<ReplicaPreserveDivergenceResult, { status: 'ok' }>['conflict']
): string[] {
  switch (conflict.kind) {
    case 'clean':
      return ['conflict: none']
    case 'conflicted':
      return [
        `conflict: ${conflict.paths.length} ${plural(conflict.paths.length, 'path', 'paths')}`,
        ...conflict.paths.map((path) => `  ${path}`)
      ]
    case 'unknown':
      // Why: a failed probe is not "no conflict"; the word none must not appear for it.
      return [`conflict: could not be determined (${conflict.reason})`]
    default:
      return unreachable(conflict)
  }
}

/** Preserve divergence: ok (even when the merge would conflict) exits 0; refusals and failures exit 1. */
export function formatReplicaPreserveDivergence(
  result: ReplicaPreserveDivergenceResult,
  setupId: string
): ReplicaCommandOutput {
  const command = 'replica-preserve-divergence'
  switch (result.status) {
    case 'ok': {
      const lines = [
        `local ${result.refs.local}`,
        `remote ${result.refs.remote}`,
        `merge base ${short(result.mergeBase)}`,
        ...conflictLines(result.conflict)
      ]
      if (result.alreadyPreserved) {
        lines.push('already preserved')
      }
      return { text: lines.join('\n'), exitCode: 0 }
    }
    case 'refused':
      if (result.reason === 'not-diverged') {
        return { text: `the pair is not diverged (${result.relation})`, exitCode: 1 }
      }
      if (result.reason === 'ref-occupied') {
        return {
          text: `${command}: refused (ref-occupied) — a divergence ref already points elsewhere; it was not moved.`,
          exitCode: 1
        }
      }
      return { text: refusalLine(command, result.reason, setupId), exitCode: 1 }
    case 'failed':
      return { text: preserveFailureText(result), exitCode: 1 }
    case 'unavailable':
      return unavailableLine(command, result.reason)
    case 'not-found':
      return notFoundLine(command, result.reason)
    default:
      return unreachable(result)
  }
}

// Why: a Record over the whole refusal union, so a new reconcile refusal is a type error here.
const RECONCILE_SENTENCE: Record<
  ReplicaReconcileRefusal,
  (setupId: string, remoteCapsule: string) => string
> = {
  'remote-caller': (setupId) => refusalLine('replica-reconcile', 'remote-caller', setupId),
  'no-local-anchor': (setupId) => refusalLine('replica-reconcile', 'no-local-anchor', setupId),
  'anchor-setup': (setupId) => refusalLine('replica-reconcile', 'anchor-setup', setupId),
  'remote-runtime-unsupported': (setupId) =>
    refusalLine('replica-reconcile', 'remote-runtime-unsupported', setupId),
  'not-a-git-repo': (setupId) => refusalLine('replica-reconcile', 'not-a-git-repo', setupId),
  'worktree-missing': (setupId) => refusalLine('replica-reconcile', 'worktree-missing', setupId),
  'worktree-busy': (setupId) => refusalLine('replica-reconcile', 'worktree-busy', setupId),
  'invalid-input': () =>
    'replica-reconcile: refused (invalid-input) — the remote capsule must be a full commit id.',
  'local-clean': () => 'the local worktree has no changes; use replica-sync instead',
  'unknown-commit': (_setupId, remoteCapsule) =>
    [
      `the remote capsule ${short(remoteCapsule)} is not in this repository; fetch it from the remote host first`,
      'run: git fetch <remote> <capsule ref>'
    ].join('\n'),
  'not-same-base': () =>
    'replica-reconcile: refused (not-same-base) — the two capsules were taken from different commits, so they cannot be merged.',
  'merge-tree-unsupported': () => 'this Git is too old for merge-tree --write-tree; update Git',
  'capsule-unmerged': () =>
    'replica-reconcile: refused (capsule-unmerged) — a capsule has unmerged paths; resolve them first.',
  'capsule-unstable': () =>
    'replica-reconcile: refused (capsule-unstable) — the worktree changed while it was captured; run it again.'
}

/** Reconcile: ok means a commit under a ref and nothing else changed; conflicts and refusals exit 1. */
export function formatReplicaReconcile(
  result: ReplicaReconcileResult,
  setupId: string,
  remoteCapsule: string
): ReplicaCommandOutput {
  const command = 'replica-reconcile'
  switch (result.status) {
    case 'ok': {
      const lines = [
        `reconciled ${short(result.commit)} at ${result.ref}; HEAD and the working tree were not changed`
      ]
      const omitted = result.localOmissions.length
      if (omitted > 0) {
        lines.push(`${omitted} local ${plural(omitted, 'path was', 'paths were')} not captured`)
      }
      if (result.untrackedNotReconciled) {
        lines.push('untracked files in the capsule were not reconciled')
      }
      return { text: lines.join('\n'), exitCode: 0 }
    }
    case 'refused':
      return { text: RECONCILE_SENTENCE[result.reason](setupId, remoteCapsule), exitCode: 1 }
    case 'failed':
      if (result.reason === 'conflict') {
        return {
          text: [
            `replica-reconcile: conflict against base ${short(result.base)}; no reconciled commit was created`,
            ...[...result.conflictedPaths].sort().map((path) => `  ${path}`)
          ].join('\n'),
          exitCode: 1
        }
      }
      return {
        text: 'replica-reconcile: failed (commit-failed) — the merged commit could not be created.',
        exitCode: 1
      }
    case 'unavailable':
      return unavailableLine(command, result.reason)
    case 'not-found':
      return notFoundLine(command, result.reason)
    default:
      return unreachable(result)
  }
}
