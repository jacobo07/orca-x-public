import { translate } from '@/i18n/i18n'
import { DISCARD_HOST_CANNOT_CHECK_MESSAGE } from '@/runtime/runtime-git-client'
import { isStaleWorktreeStateError } from '../../../../../../shared/stale-worktree-state'

/**
 * What a refused discard should say, or null when the rejection is a real failure to leave alone.
 *
 * Two refusals, two sentences, because they need two different actions. One says the file moved and the
 * newer work was kept -- which is the outcome the user would have chosen, so it must not read like an
 * error. The other says the host on the other end cannot perform the check at all, so looking at the
 * file again would tell them nothing and the only thing that helps is updating the host. Collapsing
 * them tells whoever hit the second one that their file changed and their edits were preserved: two
 * false statements, and it hides the one sentence that says what to do.
 *
 * Neither mentions a hash, an oid or a token. The user authorized destroying something they looked at;
 * the machinery that recorded what that was is not their problem.
 */
export function discardRefusalMessage(error: unknown): string | null {
  if (isStaleWorktreeStateError(error)) {
    return translate(
      'auto.components.right.sidebar.source.control.discard.staleWorktreeState',
      'This file changed after you opened it, so nothing was discarded. Your newer changes are still here — review them and try again.'
    )
  }
  const message = error instanceof Error ? error.message : null
  return message === DISCARD_HOST_CANNOT_CHECK_MESSAGE ? message : null
}
