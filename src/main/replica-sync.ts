// One-way safe sync (row 65): fast-forward the local checked-out branch to a proven descendant tip.
// Order: generation fence -> tip fence -> descendant proof -> capsule (verified) -> git merge --ff-only -> verify.
// Anything else (diverged, stale, disk-full, disconnect) stays a typed failure and never moves HEAD.
import { gitExecFileAsync } from './git/runner'
import { createCapsule, type CapsuleGitRun } from './replica-capsule'
import { localCapsuleGit } from './replica-capsule-git'
import {
  compareWithRelayReplica,
  type ReplicaComparisonFailure,
  type ReplicaComparisonRequest
} from './replica-comparison-service'

const SHA = /^[0-9a-f]{40,64}$/

export type ReplicaSyncFailure =
  | 'invalid-input'
  | 'stale-generation'
  | 'stale-tip'
  | 'not-descendant'
  | 'capsule-failed'
  | 'ff-failed'
  | 'verify-failed'
  | 'not-behind'
  | `compare-${ReplicaComparisonFailure}`

export type ReplicaSyncResult =
  | { ok: true; from: string; to: string; capsuleRef?: string; capsuleCommit?: string }
  | { ok: false; reason: ReplicaSyncFailure; capsuleRef?: string }

export type GitRun = (argv: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv }) => Promise<{ stdout: string }>

const defaultGit: GitRun = (argv, opts) => gitExecFileAsync(argv, opts)

async function ok(run: Promise<unknown>): Promise<boolean> {
  try {
    await run
    return true
  } catch {
    return false
  }
}

export async function fastForwardToDescendant(args: {
  repoPath: string
  /** HEAD sha the caller proved the descendant against. */
  expectedLocalTip: string
  /** Proven descendant tip, already present in the local object store. */
  targetTip: string
  /** Generation the evidence was gathered under, and the live one. */
  evidenceGeneration: number
  currentGeneration: () => number
  git?: GitRun
  /** Runner for the pre-move capsule; defaults to the local one. */
  capsuleGit?: CapsuleGitRun
}): Promise<ReplicaSyncResult> {
  const { repoPath, expectedLocalTip, targetTip, evidenceGeneration, currentGeneration } = args
  const git = args.git ?? defaultGit
  if (!SHA.test(expectedLocalTip) || !SHA.test(targetTip) || !repoPath) {
    return { ok: false, reason: 'invalid-input' }
  }
  const head = async (): Promise<string | null> => {
    try {
      return (await git(['rev-parse', '--verify', 'HEAD^{commit}'], { cwd: repoPath })).stdout.trim()
    } catch {
      return null
    }
  }
  if (currentGeneration() !== evidenceGeneration) {
    return { ok: false, reason: 'stale-generation' }
  }
  if ((await head()) !== expectedLocalTip) {
    return { ok: false, reason: 'stale-tip' }
  }
  if (
    expectedLocalTip === targetTip ||
    !(await ok(git(['cat-file', '-e', `${targetTip}^{commit}`], { cwd: repoPath }))) ||
    !(await ok(git(['merge-base', '--is-ancestor', expectedLocalTip, targetTip], { cwd: repoPath })))
  ) {
    return { ok: false, reason: 'not-descendant' }
  }

  // A refused or throwing capsule must stop here: moving HEAD without a recoverable copy of the dirty tree is data loss.
  const capsule = await createCapsule(args.capsuleGit ?? localCapsuleGit, repoPath).catch((): null => null)
  if (!capsule || capsule.kind === 'refused') {
    return { ok: false, reason: 'capsule-failed' }
  }
  const capsuleFields = capsule.kind === 'created' ? { capsuleRef: capsule.ref, capsuleCommit: capsule.sha } : {}

  // The capsule took time; fence again so a move during capture cannot be fast-forwarded over.
  if (currentGeneration() !== evidenceGeneration) {
    return { ok: false, reason: 'stale-generation', ...capsuleFields }
  }
  if ((await head()) !== expectedLocalTip) {
    return { ok: false, reason: 'stale-tip', ...capsuleFields }
  }
  if (!(await ok(git(['merge', '--ff-only', '--quiet', targetTip], { cwd: repoPath })))) {
    return { ok: false, reason: 'ff-failed', ...capsuleFields }
  }
  if ((await head()) !== targetTip) {
    return { ok: false, reason: 'verify-failed', ...capsuleFields }
  }
  return { ok: true, from: expectedLocalTip, to: targetTip, ...capsuleFields }
}

/** Relay -> local: compare, require "local behind", then fast-forward under the generation fence. */
export async function syncFromRelayReplica(args: {
  connectionId: string
  generation: number
  currentGeneration: () => number
  request: ReplicaComparisonRequest
  localRepoPath: string
  remoteRepoPath: string
  hostKey: string
  git?: GitRun
  capsuleGit?: CapsuleGitRun
}): Promise<ReplicaSyncResult> {
  // A relay request that throws (disconnect, timeout) is a transfer failure, never a crash or a guess.
  const compared = await compareWithRelayReplica({
    connectionId: args.connectionId,
    generation: args.generation,
    request: args.request,
    localRepoPath: args.localRepoPath,
    remoteRepoPath: args.remoteRepoPath,
    hostKey: args.hostKey
  }).catch((): null => null)
  if (!compared) {
    return { ok: false, reason: 'compare-transfer-interrupted' }
  }
  if (!compared.ok) {
    return { ok: false, reason: `compare-${compared.reason}` }
  }
  const { outcome, observedTips } = compared.evidence
  if (!outcome.ok || outcome.ancestry.kind !== 'behind') {
    return { ok: false, reason: 'not-behind' }
  }
  return fastForwardToDescendant({
    repoPath: args.localRepoPath,
    expectedLocalTip: observedTips[0],
    targetTip: observedTips[1],
    evidenceGeneration: args.generation,
    currentGeneration: args.currentGeneration,
    git: args.git,
    capsuleGit: args.capsuleGit
  })
}
