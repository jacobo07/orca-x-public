// The Workspace's view of an agent's reviews and approvals, and the person's two actions on an
// approval. Built from orchestration records and judged against git NOW; nothing here is cached
// between reads, because a review or approval shown as current must be current when it is shown.
import type {
  AgentApprovalView,
  AgentFederationView,
  AgentReviewView,
  GateDecisionView
} from '../../../shared/agent-federation-view'
import type { OrchestrationDb } from './db'
import type { ReviewRow } from './review-records'
import { judgeReviewCurrency } from './review-records'
import { parseReviewFindings } from './review-findings'
import { captureRevisionSubject, type RevisionSubjectCapture } from './review-subject-capture'
import {
  decideSubjectGate,
  judgeReviewRequirement,
  judgeSubjectNow,
  parseGateSubject,
  rebindSubjectGate
} from './subject-bound-gates'

const REVIEWS_SHOWN = 8
const APPROVALS_SHOWN = 8

type Capture = (worktreePath: string) => Promise<RevisionSubjectCapture>

/** One git read per worktree per view, however many rows point at it. */
function memoize(capture: Capture): Capture {
  const seen = new Map<string, Promise<RevisionSubjectCapture>>()
  return (path) => {
    let pending = seen.get(path)
    if (!pending) {
      pending = capture(path)
      seen.set(path, pending)
    }
    return pending
  }
}

async function viewReview(review: ReviewRow, agentId: string, capture: Capture): Promise<AgentReviewView> {
  const now = review.subject_worktree === null ? null : await capture(review.subject_worktree)
  return {
    id: review.id,
    role: review.reviewer_agent_id === agentId ? 'reviewer' : 'producer',
    projectId: review.subject_project_id,
    revision: review.subject_revision,
    status: review.status,
    independence: review.independence,
    reviewerProvider: review.reviewer_provider,
    currency: judgeReviewCurrency(
      review,
      now?.outcome === 'captured' ? { revision: now.subject.revision, patchHash: now.subject.patchHash } : null
    ),
    findings: parseReviewFindings(review.findings),
    createdAt: review.created_at
  }
}

export async function readAgentFederationView(
  db: OrchestrationDb,
  agentId: string,
  capture: Capture = (path) => captureRevisionSubject(path)
): Promise<AgentFederationView> {
  const read = memoize(capture)
  const reviews = await Promise.all(
    db.reviews().listForAgent(agentId, REVIEWS_SHOWN).map((review) => viewReview(review, agentId, read))
  )
  const gates = db
    .listGates()
    .filter((gate) => parseGateSubject(gate.subject) !== null && db.getTask(gate.task_id)?.assignee_agent_id === agentId)
    .reverse()
    .slice(0, APPROVALS_SHOWN)
  const approvals: AgentApprovalView[] = []
  for (const gate of gates) {
    const subject = parseGateSubject(gate.subject)!
    const requirement = gate.review_requirement ?? 'none'
    const now = judgeSubjectNow(subject, await read(subject.worktreePath))
    const review = now.ok ? judgeReviewRequirement(db, subject, requirement) : now
    approvals.push({
      gateId: gate.id,
      taskId: gate.task_id,
      question: gate.question,
      projectId: subject.projectId,
      revision: subject.revision,
      patchHash: subject.patchHash,
      reviewRequirement: requirement,
      decision: gate.decision === 'stale' ? 'stale' : (gate.decision ?? 'pending'),
      readiness: review.ok ? { ready: true } : { ready: false, blocker: review.reason }
    })
  }
  return { outcome: 'loaded', reviews, approvals }
}

export async function decideAgentApproval(
  db: OrchestrationDb,
  input: { gateId: string; decision: 'approved' | 'rejected'; observed: { revision: string; patchHash: string } },
  capture: Capture = (path) => captureRevisionSubject(path)
): Promise<GateDecisionView> {
  const outcome = await decideSubjectGate(db, input.gateId, { decision: input.decision, observed: input.observed }, capture)
  return outcome.outcome === 'decided'
    ? { outcome: 'decided', decision: input.decision }
    : { outcome: 'refused', reason: outcome.reason, detail: outcome.detail }
}

export async function rebindAgentApproval(
  db: OrchestrationDb,
  gateId: string,
  capture: Capture = (path) => captureRevisionSubject(path)
): Promise<GateDecisionView> {
  const outcome = await rebindSubjectGate(db, gateId, capture)
  return outcome.outcome === 'decided'
    ? { outcome: 'decided', decision: 'rebound' }
    : { outcome: 'refused', reason: outcome.reason, detail: outcome.detail }
}
