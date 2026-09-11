import { translate } from '@/i18n/i18n'
import { DISCARD_HOST_CANNOT_CHECK_MESSAGE } from '@/runtime/runtime-git-client'
import {
  isDiscardObservedStateRequiredError,
  isStaleWorktreeStateError
} from '../../../../../../shared/stale-worktree-state'

/**
 * What a refused discard should say, or null when the rejection is a real failure to leave alone.
 *
 * Three refusals, three sentences, because each needs a different action from the user and they are not
 * interchangeable:
 *
 *   the file moved       nothing was destroyed and the newer work is still there. The outcome they would
 *                        have chosen, so it must not read like an error -- just look again.
 *   we could not tell    the file did NOT move; this side had no record of what it had shown, because the
 *                        listing was capped or the file could not be read. Looking at it again tells them
 *                        nothing; refreshing might.
 *   the host cannot check  nothing about this file is wrong. The other end predates the check, and the
 *                        only thing that helps is updating it.
 *
 * Collapsing any two of these tells the user something false about their own work. Sharing one code for
 * the first two once told someone their file had changed and their newer edits were preserved -- both
 * untrue -- while hiding the sentence that said what to do.
 *
 * None of them mentions a hash, an oid or a token. The user authorized destroying something they looked
 * at; the machinery that recorded what that was is not their problem.
 */
export function discardRefusalMessage(error: unknown): string | null {
  if (isStaleWorktreeStateError(error)) {
    return translate(
      'auto.components.right.sidebar.source.control.discard.staleWorktreeState',
      'This file changed after you opened it, so nothing was discarded. Your newer changes are still here — review them and try again.'
    )
  }
  if (isDiscardObservedStateRequiredError(error)) {
    return translate(
      'auto.components.right.sidebar.source.control.discard.observedStateRequired',
      'Orca could not tell what this file held when you looked at it, so nothing was discarded. Refresh Source Control and try again.'
    )
  }
  const message = error instanceof Error ? error.message : null
  return message === DISCARD_HOST_CANNOT_CHECK_MESSAGE ? message : null
}
