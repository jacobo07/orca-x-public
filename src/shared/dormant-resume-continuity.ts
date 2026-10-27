import type { DormantResumeContinuity } from './terminal-tab-types'
import type { RestorePlanPane } from './project-working-set-restore-plan'
import type { WorkingSetFactPresence } from './project-working-set-store-types'
import { provenExactResume } from './proven-exact-resume'

/**
 * What a restored row may HONESTLY say about resuming, derived from the plan that built it.
 *
 * This owns no state and classifies nothing. `project-working-set-restore-time.ts` is the continuity
 * authority; this reads the verdict it already reached and answers the narrower product question the
 * dormant surface actually asks: may I promise an exact resume, must I only offer to attempt one, or
 * is there nothing to resume?
 *
 * It exists because the verdict was being DROPPED. A pane classified `unknown` still gets
 * `resumeOnOpen`, becomes a `SleepingAgentSessionRecord`, and that record has no continuity field —
 * so the surface saw an agent, had no way to know the classifier had been unsure, and told the user
 * "Opening it resumes the Claude session." The fix is to carry the answer, not to soften the words.
 */

/** The tab's promise is the least confident thing true of any of its panes. */
const RANK: Record<DormantResumeContinuity, number> = {
  'claimed-elsewhere': 3,
  unconfirmed: 2,
  exact: 1,
  none: 0
}

function forPane(pane: RestorePlanPane): DormantResumeContinuity {
  // Why first: apply deliberately writes no resume handle for a pane live elsewhere, so without this
  // the row would fall through to "starts a new terminal" and the collision would go unsaid.
  if (pane.blockers.includes('live-elsewhere')) {
    return 'claimed-elsewhere'
  }
  if (!pane.resumeOnOpen) {
    return 'none'
  }
  // `exact-resume` is the only verdict that means today's world confirmed the conversation. Every
  // other capability reaching `resumeOnOpen` is the planner choosing to ATTEMPT an unconfirmed one.
  return pane.restoreTime.capability === 'exact-resume' ? 'exact' : 'unconfirmed'
}

export function resolveDormantResumeContinuity(
  panes: readonly RestorePlanPane[]
): DormantResumeContinuity {
  let worst: DormantResumeContinuity = 'none'
  for (const pane of panes) {
    const candidate = forPane(pane)
    if (RANK[candidate] > RANK[worst]) {
      worst = candidate
    }
  }
  return worst
}

/**
 * What a pane a workspace is about to SLEEP may honestly say, from the facts held before release.
 *
 * Sleep is the other transition that releases a live agent and promises it can come back, and it
 * reaches `exact` through the same door: the conversation has to have been found. A live handle is
 * not that. The pane was running a second ago and its provider session is recorded, which says a
 * conversation was started — not that anything can still find it. So the probe answers, and a host
 * with nothing local to stat, a search that missed and a stalled mount all arrive as `unknown` and
 * withhold the promise rather than inventing one.
 *
 * `claimed-elsewhere` is deliberately unreachable here: the pane being slept IS the local owner, so
 * its own handle is not a foreign claim. A session simultaneously live on another host is a case
 * the collision authority owns, and minting the verdict here would say the wrong thing about it.
 */
export type SleptPaneEvidence = {
  /** Whether this pane has a recorded session worth resuming at all. */
  hasRecordedSession: boolean
  /** Whether the conversation was FOUND. `unknown` for every host this process cannot stat. */
  transcript: WorkingSetFactPresence
  /** Whether the directory the pane belongs to is still one this workspace knows. */
  location: WorkingSetFactPresence
}

function forSleptPane(pane: SleptPaneEvidence): DormantResumeContinuity {
  if (!pane.hasRecordedSession) {
    return 'none'
  }
  return provenExactResume(pane.transcript, pane.location) ? 'exact' : 'unconfirmed'
}

export function resolveSleptResumeContinuity(
  panes: readonly SleptPaneEvidence[]
): DormantResumeContinuity {
  let worst: DormantResumeContinuity = 'none'
  for (const pane of panes) {
    const candidate = forSleptPane(pane)
    if (RANK[candidate] > RANK[worst]) {
      worst = candidate
    }
  }
  return worst
}

/**
 * What a row in the store may say, given its marker and whether it still holds a resume handle.
 *
 * ABSENT IS NOT "NONE". A marker with no verdict is a row no classifier ever judged — one persisted
 * before this field existed, or one an explicit workspace sleep created, which records a live
 * session's handle without asking whether its conversation can still be found. Both are genuinely
 * unknown, and unknown may not produce an affirmative promise. The row is still offered; only the
 * certainty is withdrawn.
 */
export function readDormantResumeContinuity(
  declared: DormantResumeContinuity | undefined,
  hasResumeHandle: boolean
): DormantResumeContinuity {
  if (declared) {
    return declared
  }
  return hasResumeHandle ? 'unconfirmed' : 'none'
}
