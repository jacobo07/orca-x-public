// A review as a consumer should read it: its findings parsed, and whether it still describes the
// subject — judged now, against git, never remembered from when the review ran.
import { captureRevisionSubject, type RevisionSubjectCapture } from './review-subject-capture'
import { judgeReviewCurrency, type ReviewCurrency, type ReviewRow } from './review-records'
import { parseReviewFindings, type ReviewFindingsDocument } from './review-findings'

export type ReviewView = {
  findings: ReviewFindingsDocument | null
  /** Whether the worktree still holds exactly the reviewed commit and patch. */
  currency: ReviewCurrency
}

export async function describeReview(
  review: ReviewRow,
  capture: (worktreePath: string) => Promise<RevisionSubjectCapture> = (path) => captureRevisionSubject(path)
): Promise<ReviewView> {
  const findings = parseReviewFindings(review.findings)
  if (review.subject_worktree === null) {
    return { findings, currency: { current: false, reason: 'subject-unreadable' } }
  }
  const now = await capture(review.subject_worktree)
  return {
    findings,
    currency: judgeReviewCurrency(
      review,
      now.outcome === 'captured' ? { revision: now.subject.revision, patchHash: now.subject.patchHash } : null
    )
  }
}
