// Reads the model's facts for one local setup: tip, worktree and capsule, plus whether history is shallow.
import { worktreeFactFromPorcelain } from '../shared/replica-worktree-facts'
import type { RepoKind } from '../shared/repo-types'
import type {
  CapsuleFact,
  ReplicaFacts,
  TipFact,
  WorktreeFact
} from '../shared/workspace-replica-state'
import { gitExecFileAsync } from './git/runner'
import { listCapsules } from './replica-capsule'
import { localCapsuleGit } from './replica-capsule-git'

export type LocalReplicaRead = {
  facts: ReplicaFacts
  /** A shallow history cannot decide ancestry; the caller must not read a comparison against it as complete. */
  shallow: boolean
}

const MAX_STATUS_BYTES = 16 * 1024 * 1024

async function gitOut(path: string, argv: string[]): Promise<string | null> {
  try {
    const { stdout } = await gitExecFileAsync(argv, { cwd: path, maxBuffer: MAX_STATUS_BYTES })
    return stdout
  } catch {
    return null
  }
}

async function readTip(path: string): Promise<TipFact> {
  if ((await gitOut(path, ['rev-parse', '--git-dir'])) === null) {
    return { kind: 'unknown', reason: 'not-a-git-repo' }
  }
  const branch = (await gitOut(path, ['symbolic-ref', '-q', 'HEAD']))?.trim() || null
  const head = (await gitOut(path, ['rev-parse', '--verify', 'HEAD^{commit}']))?.trim() || null
  if (head === null) {
    // A symbolic HEAD with no commit behind it is a repo that has not committed yet.
    return branch ? { kind: 'unborn' } : { kind: 'unknown', reason: 'head-unreadable' }
  }
  return branch ? { kind: 'commit', sha: head, ref: branch } : { kind: 'detached', sha: head }
}

async function readWorktree(path: string): Promise<WorktreeFact> {
  const out = await gitOut(path, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  return out === null ? { kind: 'unknown', reason: 'status-unreadable' } : worktreeFactFromPorcelain(out)
}

async function readCapsule(path: string, tip: TipFact): Promise<CapsuleFact | undefined> {
  let listed: Awaited<ReturnType<typeof listCapsules>>
  try {
    listed = await listCapsules(localCapsuleGit, path)
  } catch {
    return undefined
  }
  const tipSha = tip.kind === 'commit' || tip.kind === 'detached' ? tip.sha : null
  const present = listed.flatMap((c) => ('damaged' in c ? [] : [c]))
  const pick = present.find((c) => c.baseTip === tipSha) ?? present[0]
  if (pick) {
    return { kind: 'present', ref: pick.ref, sha: pick.sha, baseTip: pick.baseTip, partial: pick.partial }
  }
  const damaged = listed.find((c) => 'damaged' in c)
  return damaged && 'damaged' in damaged
    ? { kind: 'damaged', ref: damaged.ref, reason: damaged.reason }
    : undefined
}

export async function readLocalReplicaFacts(args: {
  setupId: string
  hostId: string
  path: string
  kind?: RepoKind
}): Promise<LocalReplicaRead> {
  if (args.kind === 'folder') {
    return { facts: { kind: 'folder' }, shallow: false }
  }
  const { setupId, hostId, path } = args
  const tip = await readTip(path)
  if (tip.kind === 'unknown') {
    return { facts: { setupId, hostId, tip, worktree: { kind: 'unknown', reason: tip.reason } }, shallow: false }
  }
  const [worktree, shallowOut, capsule] = await Promise.all([
    readWorktree(path),
    gitOut(path, ['rev-parse', '--is-shallow-repository']),
    readCapsule(path, tip)
  ])
  return {
    facts: { setupId, hostId, tip, worktree, ...(capsule ? { capsule } : {}) },
    shallow: shallowOut?.trim() === 'true'
  }
}
