import type { WorkingSetFactPresence } from './project-working-set-store-types'

/**
 * The one definition of "today's world confirmed this conversation".
 *
 * Two transitions release a live agent pane and promise it can come back: restoring a sealed
 * working set, and sleeping a workspace. They differ in everything except this question, and the
 * moment each answers it for itself they can disagree — one row promising an exact resume where
 * the other would only offer to attempt one, for the same pane, on the same evidence.
 *
 * So the predicate lives here and neither owns it. A recorded provider session is not enough: it
 * says a conversation was started, not that it is still findable. `unknown` is not `absent` and
 * neither of them proves anything, which is why this is a positive test on `present` rather than a
 * negative one on `absent` — a probe that timed out, an unreachable host and a stopped WSL distro
 * all arrive here as `unknown`, and none of them may earn a promise.
 */
export function provenExactResume(
  /** Whether the conversation's transcript was FOUND. Null for a pane that captured no session. */
  transcript: WorkingSetFactPresence | null,
  /** Whether the directory the pane belongs to was found. */
  location: WorkingSetFactPresence
): boolean {
  return transcript === 'present' && location === 'present'
}
