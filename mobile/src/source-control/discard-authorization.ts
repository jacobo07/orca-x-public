import {
  GIT_DISCARD_OBSERVED_STATE_REQUIRED_CODE,
  GIT_DISCARD_STALE_STATE_RUNTIME_CAPABILITY
} from '../../../src/shared/protocol-version'
import type { MobileGitStatusEntry } from './mobile-git-status'

/**
 * Whether this host checks that a discard still matches the state the client saw.
 *
 * The reason the entry alone is not enough: an older host omits the identity from every row, which
 * looks the same as a newer host that could not read one file. And an older host silently ignores a
 * precondition it does not understand -- so a client that sent one and assumed protection would be
 * wrong in exactly the case the protection exists for. Only the advertisement tells those apart.
 */
export function hostEnforcesDiscardPrecondition(
  capabilities: readonly string[] | undefined
): boolean {
  return capabilities?.includes(GIT_DISCARD_STALE_STATE_RUNTIME_CAPABILITY) === true
}

export type DiscardAuthorization =
  /** The client can name what it is destroying, and the host will check it. */
  | { kind: 'ready'; expectedContent: string }
  /** The host predates the check. Discarding here cannot be made safe from this side. */
  | { kind: 'host-cannot-check'; reason: string }
  /** The host checks, but this row arrived without an identity, so there is nothing to state. */
  | { kind: 'state-unknown'; reason: string }

const HOST_CANNOT_CHECK =
  'This Orca host is too old to check whether the file changed since you looked. Update the host to discard from here.'

const STATE_UNKNOWN =
  'Orca could not read this file just now, so it cannot tell whether it still holds what you saw. Refresh and try again.'

/**
 * The single contract both discard surfaces answer to.
 *
 * Deliberately not a boolean: the two refusals need different words because they need different
 * fixes -- one is "update the host", the other is "refresh". Collapsing them would produce the
 * generic failure the user cannot act on.
 *
 * Note what is NOT here: any comparison performed on this device. A stale client is precisely the
 * party that cannot know whether the file still matches; all this does is state what it saw, and
 * the host is the only party that decides.
 */
export function resolveDiscardAuthorization(
  entry: Pick<MobileGitStatusEntry, 'worktreeContentId'> | null | undefined,
  hostEnforces: boolean
): DiscardAuthorization {
  if (!hostEnforces) {
    return { kind: 'host-cannot-check', reason: HOST_CANNOT_CHECK }
  }
  const expectedContent = entry?.worktreeContentId
  if (typeof expectedContent !== 'string' || expectedContent.length === 0) {
    return { kind: 'state-unknown', reason: STATE_UNKNOWN }
  }
  return { kind: 'ready', expectedContent }
}

/** True only when the destructive action may be offered as a normal, protected one. */
export function canDiscardSafely(authorization: DiscardAuthorization): boolean {
  return authorization.kind === 'ready'
}

const OBSERVED_STATE_REQUIRED =
  'This version of the app cannot discard safely, so nothing was discarded. Update the app, or discard from the desktop.'

/**
 * What a refused discard should say, or null to leave the host's own message alone.
 *
 * A conflict is not a failure and should not read like one: the user's newer work was kept, which
 * is the outcome they would have chosen. It asks them to look again, and never mentions a hash.
 *
 * The second case is its opposite and must never borrow the first's words. A conflict means the file
 * DID change; this means it did not, and the client simply could not say what it had seen. While
 * both shared one code, a user with an outdated app was told their file had changed and their newer
 * edits were still there -- two false statements, sending them to look for work that was never at
 * risk instead of updating the app.
 */
export function discardConflictMessage(errorCode: string | undefined): string | null {
  if (errorCode === GIT_DISCARD_OBSERVED_STATE_REQUIRED_CODE) {
    return OBSERVED_STATE_REQUIRED
  }
  return errorCode === 'stale_worktree_state'
    ? 'This file changed after you opened it, so nothing was discarded. Your newer changes are still here — review them and try again.'
    : null
}
