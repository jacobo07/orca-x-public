// When a review's task settles, the review settles from what actually happened: the reviewer's
// provider comes from the turn's recorded result, and a turn that did not complete is a failed
// review with its reason — never a completed one with no findings.
import type { OrchestrationDb } from './db'
import type { AgentTaskOutcome } from './agent-task-contract'
import { failedReview, parseReviewReply } from './review-findings'

export function settleReviewForTask(db: OrchestrationDb, taskId: string, outcome: AgentTaskOutcome): void {
  const store = db.reviews()
  const review = store.getByTask(taskId)
  if (!review) {
    return
  }
  switch (outcome.outcome) {
    case 'completed':
      store.settle(review.id, {
        status: 'completed',
        reviewerProvider: outcome.provider ?? null,
        findings: JSON.stringify(parseReviewReply(outcome.text))
      })
      return
    case 'refused':
      store.settle(review.id, {
        status: 'failed',
        reviewerProvider: null,
        findings: JSON.stringify(failedReview(outcome.reason, outcome.detail))
      })
      return
    case 'failed':
      store.settle(review.id, {
        status: 'failed',
        reviewerProvider: outcome.provider ?? null,
        findings: JSON.stringify(failedReview(outcome.reason, 'The review turn did not complete.'))
      })
  }
}
