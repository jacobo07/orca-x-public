/**
 * The refusal a discard produces when the file is no longer what the caller said it was.
 *
 * Split out from the identity module because the renderer needs to RECOGNISE this refusal while having
 * no business computing an identity: that module reads files and hashes them, so importing it from a
 * renderer surface would drag node:crypto and node:fs into a browser bundle to answer a question about
 * an error object. Nothing here touches either.
 */

export const STALE_WORKTREE_STATE_CODE = 'stale_worktree_state'

/**
 * A marker inside the refusal's own message, because a `code` property does not survive every hop.
 *
 * The runtime RPC boundary carries structured codes and the relay carries its own, but Electron's IPC
 * rehydrates a rejection as a plain Error and keeps only the text -- so a local desktop discard reaches
 * the renderer with the class, the name and the code all gone. Living inside the constructor below
 * means the thing the predicate matches and the thing the error says cannot drift apart.
 */
export const STALE_WORKTREE_STATE_MARKER = 'changed since it was last read'

/** The file at this path is no longer what the caller said it was when it authorized the discard. */
export class StaleWorktreeStateError extends Error {
  readonly code = STALE_WORKTREE_STATE_CODE
  constructor(readonly filePath: string) {
    super(`"${filePath}" ${STALE_WORKTREE_STATE_MARKER}, so the discard was not applied`)
    this.name = 'StaleWorktreeStateError'
  }
}

/**
 * Was this rejection a refusal to destroy, rather than a failure to?
 *
 * The distinction is the whole product difference: a refusal means the user's newer work is still
 * there, so reporting it as an error sends them looking for a problem instead of at their file. Checks
 * the structured code first and falls back to the marker on the hops that drop it.
 */
export function isStaleWorktreeStateError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false
  }
  if ((error as { code?: unknown }).code === STALE_WORKTREE_STATE_CODE) {
    return true
  }
  const message = (error as { message?: unknown }).message
  return typeof message === 'string' && message.includes(STALE_WORKTREE_STATE_MARKER)
}
