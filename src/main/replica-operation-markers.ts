// The git-dir entries that mean "a rebase, merge, cherry-pick, revert or bisect owns HEAD". One list for sync and both capsule paths.
import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'

export const OPERATION_MARKERS = [
  'MERGE_HEAD',
  'CHERRY_PICK_HEAD',
  'REVERT_HEAD',
  'REBASE_HEAD',
  'BISECT_LOG',
  'rebase-merge',
  'rebase-apply'
] as const

/**
 * True when any marker exists for the worktree at `cwd`. Paths come from `git rev-parse --git-path`, so a linked
 * worktree is read from its own git dir. A probe that fails answers true: an operation we cannot rule out is one in progress.
 */
export async function operationInProgress(
  run: (argv: string[], opts: { cwd: string }) => Promise<string>,
  cwd: string
): Promise<boolean> {
  try {
    const out = await run(['rev-parse', ...OPERATION_MARKERS.flatMap((m) => ['--git-path', m])], {
      cwd
    })
    const paths = out.split('\n').filter(Boolean)
    if (paths.length !== OPERATION_MARKERS.length) {
      return true
    }
    const found = await Promise.all(
      paths.map((p) =>
        stat(resolve(cwd, p)).then(
          () => true,
          () => false
        )
      )
    )
    return found.some(Boolean)
  } catch {
    return true
  }
}
