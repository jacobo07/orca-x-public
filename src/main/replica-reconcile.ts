// Dirty-both reconciliation (row 67): two capsules cut from the SAME base (each a commit whose FIRST parent is that base)
// are reconciled only when `git merge-tree --write-tree` reports a clean merge. Anything else is a typed conflict.
// Nothing here touches a working tree or moves HEAD: a clean result is a commit under refs/orca/reconciled/*.
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
  | {
      ok: true
      base: string
      tree: string
      commit: string
      ref: string
      /** A capsule carried untracked files; the merge of the W trees does not include them. */
      untrackedNotReconciled: boolean
    }
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

/** The later committer time of the two capsules, as git's raw date: a pure function of the inputs. */
async function commitTime(git: GitRun, cwd: string, commits: string[]): Promise<string> {
  const times = (await git(['log', '--no-walk', '--format=%ct', ...commits], { cwd })).stdout
    .trim()
    .split('\n')
    .map(Number)
  return `${Math.max(...times)} +0000`
}

/** Creates the ref, or accepts it already pointing at the same commit; an existing ref is never moved. */
async function createOrSame(git: GitRun, cwd: string, ref: string, commit: string): Promise<boolean> {
  try {
    await git(['update-ref', ref, commit, '0'.repeat(commit.length)], { cwd })
    return true
  } catch {
    const existing = await revParse(git, cwd, ref)
    return existing === commit
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
  /** Local and remote capsule commits (W). Both must have this base as their FIRST parent. */
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
  // Capsule W parents are [base, index, optional untracked]; a third parent means untracked files exist.
  const parentsOf = async (c: string): Promise<string[] | null> => {
    try {
      const parts = (await git(['rev-list', '--parents', '-n', '1', c], { cwd: repoPath })).stdout.trim().split(/\s+/)
      return parts.length >= 2 && parts.length <= 4 ? parts.slice(1) : null
    } catch {
      return null
    }
  }
  const [lp, rp] = await Promise.all([parentsOf(l), parentsOf(r)])
  if (!lp || !rp || lp[0] !== b || rp[0] !== b) {
    return { ok: false, reason: 'not-same-base' }
  }
  const untrackedNotReconciled = lp.length === 3 || rp.length === 3
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
    // Why: inputs alone decide the commit and the ref, so re-running the same reconcile finds what it made, never a twin.
    const when = await commitTime(git, repoPath, [l, r])
    const { stdout: made } = await git(
      ['-c', 'user.name=orca', '-c', 'user.email=orca@localhost', 'commit-tree', tree, '-p', l, '-p', r, '-m', 'orca dirty-both reconcile'],
      { cwd: repoPath, env: { ...process.env, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when } }
    )
    const commit = made.trim()
    const ref = `${RECONCILED_REF_PREFIX}${l.slice(0, 12)}-${r.slice(0, 12)}`
    if (!(await createOrSame(git, repoPath, ref, commit))) {
      return { ok: false, reason: 'commit-failed' }
    }
    return { ok: true, base: b, tree, commit, ref, untrackedNotReconciled }
  } catch {
    return { ok: false, reason: 'commit-failed' }
  }
}
