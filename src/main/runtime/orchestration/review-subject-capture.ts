// What a review is about, captured by Orca from git — never described by the agent that built it
// or the one reviewing it. The patch hash must mean the same bytes on every machine, so every diff
// knob a user's config can turn is pinned here (abbreviation, prefixes, renames, algorithm, path
// quoting, textconv, external diff). Plumbing only; every flag exists in Git 2.25.
import { createHash } from 'node:crypto'
import { gitExecFileAsync } from '../../git/runner'

export type CapturedRevisionSubject = {
  revision: string
  patchHash: string
  /** Exactly the bytes `patchHash` hashes: what a reviewer is shown is what was fingerprinted. */
  patch: string
}

export type RevisionSubjectCapture =
  | { outcome: 'captured'; subject: CapturedRevisionSubject }
  | {
      outcome: 'unreadable'
      /** A merge has no single patch to review, so it is refused rather than reviewed as empty. */
      reason: 'revision-not-found' | 'merge-commit' | 'git-failed'
      detail: string
    }

const PATCH_MAX_BUFFER = 64 * 1024 * 1024

export function hashPatch(patch: string): string {
  return createHash('sha256').update(patch, 'utf8').digest('hex')
}

export async function captureRevisionSubject(
  worktreePath: string,
  revision = 'HEAD'
): Promise<RevisionSubjectCapture> {
  const git = (args: string[]) => gitExecFileAsync(args, { cwd: worktreePath, maxBuffer: PATCH_MAX_BUFFER })
  let sha: string
  try {
    sha = (await git(['rev-parse', '--verify', '--quiet', `${revision}^{commit}`])).stdout.trim()
  } catch (error) {
    return {
      outcome: 'unreadable',
      reason: 'revision-not-found',
      detail: `${revision} is not a commit in ${worktreePath}: ${String((error as Error).message ?? error)}`
    }
  }
  if (!sha) {
    return { outcome: 'unreadable', reason: 'revision-not-found', detail: `${revision} is not a commit.` }
  }
  try {
    const parents = (await git(['rev-list', '--parents', '-n', '1', sha])).stdout.trim().split(/\s+/)
    if (parents.length > 2) {
      return { outcome: 'unreadable', reason: 'merge-commit', detail: `${sha} is a merge; review its parents' commits instead.` }
    }
    const patch = (
      await git([
        '-c',
        'core.quotepath=true',
        'diff-tree',
        '-p',
        '--root',
        '--no-commit-id',
        '--no-color',
        '--no-ext-diff',
        '--no-textconv',
        '--no-renames',
        '--full-index',
        '--diff-algorithm=myers',
        '--src-prefix=a/',
        '--dst-prefix=b/',
        sha
      ])
    ).stdout
    return { outcome: 'captured', subject: { revision: sha, patchHash: hashPatch(patch), patch } }
  } catch (error) {
    return { outcome: 'unreadable', reason: 'git-failed', detail: String((error as Error).message ?? error) }
  }
}
