import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import * as path from 'node:path'

/** An absent file is a state a caller can legitimately have observed, and must not collide with any
 *  content -- least of all with empty, which is a different thing entirely. */
export const ABSENT_WORKTREE_CONTENT = 'absent'

// Re-exported so the hosts keep one import for the identity and the refusal it produces, while a
// renderer surface can take the refusal alone without pulling node:crypto and node:fs into its bundle.
export {
  isStaleWorktreeStateError,
  StaleWorktreeStateError,
  STALE_WORKTREE_STATE_CODE,
  STALE_WORKTREE_STATE_MARKER
} from './stale-worktree-state'
import { StaleWorktreeStateError } from './stale-worktree-state'

/** Shared by the two hosts that can execute a discard -- this process for a local worktree, the
 *  relay for one over SSH. One definition, because a precondition only means anything if both ends
 *  compute the same string for the same bytes. */
export function isWithinWorktreePath(resolvedWorktree: string, resolvedTarget: string): boolean {
  const relativeTarget = path.relative(resolvedWorktree, resolvedTarget)
  return !(
    relativeTarget === '' ||
    relativeTarget === '..' ||
    relativeTarget.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeTarget)
  )
}

/**
 * Identity of the bytes currently on disk at a path.
 *
 * Deliberately not the blob oids git hands out for free. `git status --porcelain=v2` prints the HEAD
 * and index oids and the worktree MODE, and no worktree content hash at all -- git never hashes the
 * working file during status, by design. Those oids identify states discard does not destroy: a
 * discard of a tracked path rewrites the working tree from HEAD and leaves the index alone, so what
 * is lost is exactly the bytes neither oid describes. Using the index oid because it is available
 * would let a file edited twice against an unchanged index pass as unchanged.
 *
 * Hashing the on-disk bytes also settles the filter question for free: whatever clean/smudge or
 * line-ending conversion is configured, this is the form that actually disappears.
 */
export async function readWorktreeContentIdentity(
  worktreePath: string,
  filePath: string
): Promise<string> {
  const resolvedWorktree = path.resolve(worktreePath)
  const resolvedTarget = path.resolve(worktreePath, filePath)
  if (!isWithinWorktreePath(resolvedWorktree, resolvedTarget)) {
    throw new Error(`Path "${filePath}" resolves outside the worktree`)
  }
  try {
    const contents = await readFile(resolvedTarget)
    return `sha256:${createHash('sha256').update(contents).digest('hex')}`
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return ABSENT_WORKTREE_CONTENT
    }
    // Why not fall through to the absent sentinel: an unreadable file is not a missing one, and
    // treating a permissions error as "nothing here" would authorize destroying what we cannot see.
    throw error
  }
}

/**
 * How many of these may run at once when stamping a status snapshot.
 *
 * A memory budget, not a speed knob: each call holds a whole file, so RSS tracks file size exactly
 * (measured: an 8MB file costs 8MB) and an unbounded fan-out peaks at the SUM of every changed file
 * -- 24 ordinary 8MB files produced a 128MB burst on one refresh. Lives here with the identity for
 * the same reason the identity does: the relay computes it for SSH worktrees, and two numbers would
 * be two budgets.
 */
export const WORKTREE_CONTENT_IDENTITY_CONCURRENCY = 8

/** What the caller believed it was destroying, from `readWorktreeContentIdentity`. */
export type DiscardPrecondition = {
  expectedContent?: string | null
}

/**
 * Checked immediately before the destructive call, and nowhere else.
 *
 * A client-side "nothing changed" check would be worthless: the stale client is precisely the party
 * that cannot know. Any gap between this read and the mutation is a gap an edit can land in, so this
 * sits as close to the destruction as the code allows.
 *
 * That last sentence was untrue when it was first written, which is the reason it is now spelled out
 * as a constraint on callers rather than a description of them: both hosts ran a tracked/untracked
 * `ls-files` probe between this check and the write, and the relay additionally re-entered a second
 * method that redid containment over a remote shell. Anything a caller needs before destroying --
 * probes, containment, cache invalidation -- belongs ABOVE this call, because none of it is a write
 * and all of it is time. `discard-precondition-ordering.test.ts` fails if that order is reversed.
 */
export async function assertWorktreeStateUnchanged(
  worktreePath: string,
  filePath: string,
  precondition: DiscardPrecondition | undefined
): Promise<void> {
  const expected = precondition?.expectedContent
  if (expected === undefined || expected === null) {
    return
  }
  if ((await readWorktreeContentIdentity(worktreePath, filePath)) !== expected) {
    throw new StaleWorktreeStateError(filePath)
  }
}
