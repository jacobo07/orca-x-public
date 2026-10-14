// Dirty-both reconciliation (row 67): two capsules cut from the SAME base (each a commit whose parent is that base)
// are reconciled only when `git merge-tree --write-tree` reports a clean merge. Anything else is a typed conflict.
// Nothing here touches a working tree or moves HEAD: a clean result is a commit under refs/orca/reconciled/*.
import { randomUUID } from 'node:crypto'
import { gitExecFileAsync } from './git/runner'
import type { GitRun } from './replica-sync'

const SHA = /^[0-9a-f]{40,64}$/
export const RECONCILED_REF_PREFIX = 'refs/orca/reconciled/'

export type ReconcileFailure =
  | 'invalid-input'
  | 'unknown-commit'
  | 'not-same-base'
  | 'merge-tree-unsupported'
  | 'conflict'
  | 'commit-failed'

export type ReconcileResult =
  | { ok: true; base: string; tree: string; commit: string; ref: string }
  | { ok: false; reason: 'conflict'; base: string; conflictedPaths: string[] }
  | { ok: false; reason: Exclude<ReconcileFailure, 'conflict'> }

const defaultGit: GitRun = (argv, opts) => gitExecFileAsync(argv, opts)

async function revParse(git: GitRun, cwd: string, rev: string): Promise<string | null> {
  try {
    return (await git(['rev-parse', '--verify', `${rev}^{commit}`], { cwd })).stdout.trim()
  } catch {
    return null
  }
}

/** Parse `merge-tree --write-tree --name-only` stdout: line 1 tree oid, then conflicted paths up to a blank line. */
export function parseMergeTreeOutput(stdout: string): { tree: string; conflictedPaths: string[] } {
  const [tree = '', ...rest] = stdout.split('\n')
  const paths: string[] = []
  for (const line of rest) {
    if (line === '') {
      break
    }
    paths.push(line)
  }
  return { tree: tree.trim(), conflictedPaths: [...new Set(paths)].sort() }
}

export async function reconcileDirtyBoth(args: {
  repoPath: string
  /** Local and remote capsule commits. Both must have exactly this base as their single parent. */
  localCapsule: string
  remoteCapsule: string
  base: string
  git?: GitRun
}): Promise<ReconcileResult> {
  const { repoPath, base } = args
  const git = args.git ?? defaultGit
  if (![args.localCapsule, args.remoteCapsule, base].every((s) => SHA.test(s)) || !repoPath) {
    return { ok: false, reason: 'invalid-input' }
  }
  const [l, r, b] = await Promise.all(
    [args.localCapsule, args.remoteCapsule, base].map((s) => revParse(git, repoPath, s))
  )
  if (!l || !r || !b) {
    return { ok: false, reason: 'unknown-commit' }
  }
  const parentOf = async (c: string): Promise<string | null> => {
    try {
      const parts = (await git(['rev-list', '--parents', '-n', '1', c], { cwd: repoPath })).stdout.trim().split(/\s+/)
      return parts.length === 2 ? parts[1] : null
    } catch {
      return null
    }
  }
  const [lp, rp] = await Promise.all([parentOf(l), parentOf(r)])
  if (lp !== b || rp !== b) {
    return { ok: false, reason: 'not-same-base' }
  }
  let stdout: string
  try {
    stdout = (await git(['merge-tree', '--write-tree', '--name-only', l, r], { cwd: repoPath })).stdout
  } catch (error) {
    const e = error as { code?: unknown; stdout?: unknown }
    if (e.code === 1 && typeof e.stdout === 'string') {
      return { ok: false, reason: 'conflict', base: b, conflictedPaths: parseMergeTreeOutput(e.stdout).conflictedPaths }
    }
    return { ok: false, reason: 'merge-tree-unsupported' }
  }
  const { tree } = parseMergeTreeOutput(stdout)
  if (!SHA.test(tree)) {
    return { ok: false, reason: 'merge-tree-unsupported' }
  }
  try {
    const { stdout: made } = await git(
      ['-c', 'user.name=orca', '-c', 'user.email=orca@localhost', 'commit-tree', tree, '-p', l, '-p', r, '-m', 'orca dirty-both reconcile'],
      { cwd: repoPath }
    )
    const commit = made.trim()
    const ref = `${RECONCILED_REF_PREFIX}${randomUUID()}`
    await git(['update-ref', ref, commit], { cwd: repoPath })
    return { ok: true, base: b, tree, commit, ref }
  } catch {
    return { ok: false, reason: 'commit-failed' }
  }
}
