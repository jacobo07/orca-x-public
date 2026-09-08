/**
 * Playwright globalTeardown: removes the test git repo and the worktrees attached to it.
 *
 * Two rules govern everything here.
 *
 * It may only delete what it can prove it owns. Worktree ownership comes from git — the
 * worktrees registered against this run's own repository — not from a name prefix in a shared
 * temp directory, because a prefix cannot tell this run's worktree from a concurrent run's live
 * one, and deleting under another run's feet is worse than leaking a directory.
 *
 * And it may not decide the verdict. Every test has already been measured by the time this runs,
 * so an exception here does not report a cleanup problem — it rewrites a passing suite into a
 * failing one. Failures are classified, reported and survived. A cleanup that keeps failing is a
 * harness health problem and the log has to say so; what it must never say is that the product
 * failed.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync, rmSync } from 'node:fs'
import path from 'node:path'
import { TEST_REPO_PATH_FILE } from './global-setup'
import { classifyE2EFailure } from './helpers/e2e-precondition'

/** Bounded: cleanup runs after the suite, and a hung git here would stall the whole run. */
const GIT_WORKTREE_LIST_TIMEOUT_MS = 15_000

function reportCleanupFailure(what: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  const verdict = classifyE2EFailure({ message, origin: 'teardown' })
  console.error(`[e2e] ${verdict}: could not remove ${what} — ${message}`)
}

function removeOwned(target: string, what: string): void {
  try {
    rmSync(target, { recursive: true, force: true })
  } catch (error) {
    reportCleanupFailure(what, error)
  }
}

/**
 * The worktrees git itself reports for this repository, excluding the repository directory.
 * Returns nothing when ownership cannot be established — a leaked directory is recoverable,
 * a deleted one belonging to someone else is not.
 */
function worktreesOwnedBy(testRepoDir: string): string[] {
  let listed: string
  try {
    listed = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: testRepoDir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: GIT_WORKTREE_LIST_TIMEOUT_MS
    })
  } catch (error) {
    reportCleanupFailure('worktree list (ownership unproven, leaving worktrees in place)', error)
    return []
  }
  const repoRoot = path.resolve(testRepoDir)
  return listed
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => path.resolve(line.slice('worktree '.length).trim()))
    .filter((worktree) => worktree !== repoRoot && existsSync(worktree))
}

export default function globalTeardown(): void {
  if (!existsSync(TEST_REPO_PATH_FILE)) {
    return
  }

  const testRepoDir = readFileSync(TEST_REPO_PATH_FILE, 'utf-8').trim()
  if (testRepoDir && existsSync(testRepoDir)) {
    // Ask before deleting the repository: the answer lives inside it.
    for (const worktree of worktreesOwnedBy(testRepoDir)) {
      removeOwned(worktree, `worktree ${worktree}`)
    }
    removeOwned(testRepoDir, `test repo ${testRepoDir}`)
    if (!existsSync(testRepoDir)) {
      console.error(`[e2e] Cleaned up test repo at ${testRepoDir}`)
    }
  }

  // Unconditional: a failed repository removal must not also strand the marker, or the next run
  // inherits a pointer to a directory this one was supposed to own.
  removeOwned(TEST_REPO_PATH_FILE, `test repo path file ${TEST_REPO_PATH_FILE}`)
}
