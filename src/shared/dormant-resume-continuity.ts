import type { DormantResumeContinuity } from './terminal-tab-types'
import type { RestorePlanPane } from './project-working-set-restore-plan'

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
