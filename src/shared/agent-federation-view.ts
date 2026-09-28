// What the Workspace is told about an agent's reviews and approvals. Every field is produced in main
// from the orchestration records and from git at read time; the renderer decides nothing here.

export type ReviewSeverity = 'blocker' | 'major' | 'minor' | 'note'
export type ReviewVerdict = 'approve' | 'changes-requested'
export type ReviewFinding = { severity: ReviewSeverity; summary: string; location?: string }

export type ReviewFindingsDocument =
  | {
      schema: 'orca.review-findings/1'
      kind: 'structured'
      verdict: ReviewVerdict
      findings: ReviewFinding[]
      /** True when the verdict asks for changes or any finding is a blocker. */
      blocking: boolean
    }
  | { schema: 'orca.review-findings/1'; kind: 'unstructured'; problem: string; excerpt: string }
  | { schema: 'orca.review-findings/1'; kind: 'failed'; reason: string; detail: string }

export type ReviewIndependenceView = 'independent' | 'degraded-same-agent' | 'degraded-same-provider' | 'unknown'

export type ReviewCurrencyView =
  | { current: true }
  | { current: false; reason: 'revision-moved' | 'patch-changed' | 'subject-unreadable' }

export type AgentReviewView = {
  id: string
  /** The agent's part in it: it reviewed someone's work, or its work was reviewed. */
  role: 'reviewer' | 'producer'
  projectId: string
  revision: string
  status: 'requested' | 'completed' | 'failed'
  independence: ReviewIndependenceView
  /** The provider that actually ran the review; null until it has run. */
  reviewerProvider: string | null
  currency: ReviewCurrencyView
  findings: ReviewFindingsDocument | null
  createdAt: string
}

export type ApprovalBlocker = 'subject-unreadable' | 'subject-moved' | 'review-missing' | 'review-not-independent'

export type AgentApprovalView = {
  gateId: string
  taskId: string
  question: string
  projectId: string
  /** What the person approves. Sent back unchanged with the decision, so the decision covers exactly this. */
  revision: string
  patchHash: string
  reviewRequirement: 'none' | 'any' | 'independent'
  decision: 'pending' | 'approved' | 'rejected' | 'stale'
  /** Whether approving would be accepted right now, judged against git and the reviews. */
  readiness: { ready: true } | { ready: false; blocker: ApprovalBlocker }
}

export type AgentFederationView =
  | { outcome: 'loaded'; reviews: AgentReviewView[]; approvals: AgentApprovalView[] }
  | { outcome: 'unavailable'; reason: string }

export type GateDecisionView =
  | { outcome: 'decided'; decision: 'approved' | 'rejected' | 'rebound' }
  | { outcome: 'refused'; reason: string; detail: string }
