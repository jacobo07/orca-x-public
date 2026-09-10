import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import * as path from 'node:path'

/** An absent file is a state a caller can legitimately have observed, and must not collide with any
 *  content -- least of all with empty, which is a different thing entirely. */
export const ABSENT_WORKTREE_CONTENT = 'absent'

/** The file at this path is no longer what the caller said it was when it authorized the discard. */
export class StaleWorktreeStateError extends Error {
  readonly code = 'stale_worktree_state'
  constructor(readonly filePath: string) {
    super(`"${filePath}" changed since it was last read, so the discard was not applied`)
    this.name = 'StaleWorktreeStateError'
  }
}

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
