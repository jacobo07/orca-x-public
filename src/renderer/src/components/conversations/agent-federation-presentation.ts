// Words and tones for an agent's reviews and approvals. Every label states what main reported;
// nothing is upgraded — an unknown independence is never shown as independent.
import { translate } from '@/i18n/i18n'
import type { AgentApprovalView, AgentReviewView } from '../../../../shared/agent-federation-view'

export type FederationTone = 'ready' | 'caution' | 'refused' | 'neutral'
export type FederationFact = { label: string; tone: FederationTone }

export function describeReviewOutcome(review: AgentReviewView): FederationFact {
  if (review.status === 'requested') {
    return { label: translate('workspace.federation.reviewRunning', 'Review requested'), tone: 'neutral' }
  }
  if (review.status === 'failed') {
    const reason = review.findings?.kind === 'failed' ? review.findings.reason : ''
    return { label: translate('workspace.federation.reviewFailed', 'Review did not run') + (reason ? ` (${reason})` : ''), tone: 'refused' }
  }
  if (review.findings?.kind !== 'structured') {
    return { label: translate('workspace.federation.reviewUnstructured', 'Reviewed, no structured verdict'), tone: 'caution' }
  }
  return review.findings.blocking
    ? { label: translate('workspace.federation.changesRequested', 'Changes requested'), tone: 'refused' }
    : { label: translate('workspace.federation.approvedByReview', 'Approved by review'), tone: 'ready' }
}

export function describeIndependence(review: AgentReviewView): FederationFact {
  switch (review.independence) {
    case 'independent':
      return { label: translate('workspace.federation.independent', 'Independent'), tone: 'ready' }
    case 'degraded-same-agent':
      return { label: translate('workspace.federation.sameAgent', 'Not independent: same agent'), tone: 'caution' }
    case 'degraded-same-provider':
      return { label: translate('workspace.federation.sameProvider', 'Not independent: same provider'), tone: 'caution' }
    case 'unknown':
      return { label: translate('workspace.federation.independenceUnknown', 'Independence unknown'), tone: 'caution' }
  }
}

export function describeCurrency(review: AgentReviewView): FederationFact {
  if (review.currency.current) {
    return { label: translate('workspace.federation.current', 'Current'), tone: 'ready' }
  }
  return review.currency.reason === 'subject-unreadable'
    ? { label: translate('workspace.federation.unreadable', 'Commit cannot be read now'), tone: 'caution' }
    : { label: translate('workspace.federation.stale', 'Stale: the commit has changed'), tone: 'caution' }
}

export function describeApproval(approval: AgentApprovalView): FederationFact {
  switch (approval.decision) {
    case 'approved':
      return { label: translate('workspace.federation.approved', 'Approved'), tone: 'ready' }
    case 'rejected':
      return { label: translate('workspace.federation.rejected', 'Rejected'), tone: 'refused' }
    case 'stale':
      return { label: translate('workspace.federation.approvalStale', 'Approval stale: the commit changed'), tone: 'caution' }
    case 'pending':
      return { label: translate('workspace.federation.awaiting', 'Awaiting your decision'), tone: 'neutral' }
  }
}

export function describeApprovalBlocker(approval: AgentApprovalView): string | null {
  if (approval.readiness.ready) {
    return null
  }
  switch (approval.readiness.blocker) {
    case 'subject-moved':
      return translate('workspace.federation.blockMoved', 'The worktree no longer holds this commit.')
    case 'subject-unreadable':
      return translate('workspace.federation.blockUnreadable', 'Orca cannot read this commit now.')
    case 'review-missing':
      return translate('workspace.federation.blockReview', 'Needs an approving review of this exact commit.')
    case 'review-not-independent':
      return translate('workspace.federation.blockIndependent', 'Needs an independent review of this commit.')
  }
}
