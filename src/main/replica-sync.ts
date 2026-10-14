// One-way safe sync (row 65): fast-forward the local checked-out branch to a proven descendant tip.
// Order: generation fence -> tip fence -> descendant proof -> capsule (verified) -> git merge --ff-only -> verify.
// Anything else (diverged, stale, disk-full, disconnect) stays a typed failure and never moves HEAD.
import { randomUUID } from 'node:crypto'
import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitExecFileAsync } from './git/runner'
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
  | { ok: true; from: string; to: string; capsuleRef: string; capsuleCommit: string }
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

/** Capsule = temp-index tree of the working state -> commit (parent HEAD) under refs/orca/capsules/*. */
export async function createCapsule(
  repoPath: string,
  git: GitRun = defaultGit
): Promise<{ ref: string; commit: string } | null> {
  const scratch = await mkdtemp(join(tmpdir(), 'orca-capsule-'))
  try {
    const { stdout: gitDir } = await git(['rev-parse', '--absolute-git-dir'], { cwd: repoPath })
    const index = join(scratch, 'index')
    await copyFile(join(gitDir.trim(), 'index'), index).catch(() => {})
    const env = { ...process.env, GIT_INDEX_FILE: index }
    await git(['add', '-A', '--', '.'], { cwd: repoPath, env })
    const { stdout: tree } = await git(['write-tree'], { cwd: repoPath, env })
    const { stdout: head } = await git(['rev-parse', '--verify', 'HEAD^{commit}'], { cwd: repoPath })
    const { stdout: made } = await git(
      ['-c', 'user.name=orca', '-c', 'user.email=orca@localhost', 'commit-tree', tree.trim(), '-p', head.trim(), '-m', 'orca capsule'],
      { cwd: repoPath }
    )
    const commit = made.trim()
    const ref = `refs/orca/capsules/${randomUUID()}`
    await git(['update-ref', ref, commit], { cwd: repoPath })
    // Verified before anything moves: the ref resolves to a commit whose tree is the one we wrote.
    const { stdout: back } = await git(['rev-parse', '--verify', `${ref}^{tree}`], { cwd: repoPath })
    if (back.trim() !== tree.trim()) {
      return null
    }
    return { ref, commit }
  } catch {
    return null
  } finally {
    await rm(scratch, { recursive: true, force: true })
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

  const capsule = await createCapsule(repoPath, git)
  if (!capsule) {
    return { ok: false, reason: 'capsule-failed' }
  }

  // The capsule took time; fence again so a move during capture cannot be fast-forwarded over.
  if (currentGeneration() !== evidenceGeneration) {
    return { ok: false, reason: 'stale-generation', capsuleRef: capsule.ref }
  }
  if ((await head()) !== expectedLocalTip) {
    return { ok: false, reason: 'stale-tip', capsuleRef: capsule.ref }
  }
  if (!(await ok(git(['merge', '--ff-only', '--quiet', targetTip], { cwd: repoPath })))) {
    return { ok: false, reason: 'ff-failed', capsuleRef: capsule.ref }
  }
  if ((await head()) !== targetTip) {
    return { ok: false, reason: 'verify-failed', capsuleRef: capsule.ref }
  }
  return { ok: true, from: expectedLocalTip, to: targetTip, capsuleRef: capsule.ref, capsuleCommit: capsule.commit }
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
    git: args.git
  })
}
