// A review belongs to the exact artifact it examined. The subject is captured by Orca (a commit and
// the hash of its patch), never described by an agent; independence is DERIVED from who produced
// and who reviewed, never declared; and a review of revision A says nothing about revision B.
import type Database from '../../sqlite/sync-database'

export const REVIEWS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS reviews (
    id                 TEXT PRIMARY KEY,
    run_id             TEXT NOT NULL,
    subject_project_id TEXT NOT NULL,
    subject_worktree   TEXT,
    subject_revision   TEXT NOT NULL,
    subject_patch_hash TEXT NOT NULL,
    producer_agent_id  TEXT,
    producer_provider  TEXT,
    reviewer_agent_id  TEXT NOT NULL,
    reviewer_provider  TEXT,
    independence       TEXT NOT NULL,
    status             TEXT NOT NULL DEFAULT 'requested'
      CHECK(status IN ('requested', 'completed', 'failed')),
    review_task_id     TEXT,
    findings           TEXT,
    created_at         TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at       TEXT,
    policy             TEXT NOT NULL DEFAULT 'any',
    producer_task_id   TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_reviews_subject ON reviews(subject_project_id, subject_revision);
`

/** `unknown` when a fact independence rests on is missing: an unknown is never reported as independent. */
export type ReviewIndependence =
  | 'independent'
  | 'degraded-same-agent'
  | 'degraded-same-provider'
  | 'unknown'

/** `independent`: the reviewer must not run on the producer's provider, and a request that cannot
 *  say who produced the artifact is refused. `any`: independence is recorded, not required. */
export type ReviewPolicy = 'independent' | 'any'

export type ReviewParty = { agentId: string | null; provider: string | null }

export function deriveIndependence(producer: ReviewParty, reviewer: ReviewParty): ReviewIndependence {
  if (producer.agentId !== null && producer.agentId === reviewer.agentId) {
    return 'degraded-same-agent'
  }
  // Why the agent too: an unnamed builder may be the reviewer itself.
  if (producer.agentId === null || producer.provider === null || reviewer.provider === null) {
    return 'unknown'
  }
  return producer.provider === reviewer.provider ? 'degraded-same-provider' : 'independent'
}

export type ReviewRow = {
  id: string
  run_id: string
  subject_project_id: string
  subject_worktree: string | null
  subject_revision: string
  subject_patch_hash: string
  producer_agent_id: string | null
  producer_provider: string | null
  reviewer_agent_id: string
  reviewer_provider: string | null
  independence: ReviewIndependence
  status: 'requested' | 'completed' | 'failed'
  review_task_id: string | null
  /** JSON `orca.review-findings/1` once settled (review-findings.ts). */
  findings: string | null
  created_at: string
  completed_at: string | null
  policy: ReviewPolicy
  producer_task_id: string | null
}

/** Whether a review still describes the subject as it is now. Anything but an exact match is stale:
 *  a moved revision is a different artifact, and an unreadable one cannot be vouched for. */
export type ReviewCurrency =
  | { current: true }
  | { current: false; reason: 'revision-moved' | 'patch-changed' | 'subject-unreadable' }

export function judgeReviewCurrency(
  review: Pick<ReviewRow, 'subject_revision' | 'subject_patch_hash'>,
  now: { revision: string; patchHash: string } | null
): ReviewCurrency {
  if (now === null) {
    return { current: false, reason: 'subject-unreadable' }
  }
  if (now.revision !== review.subject_revision) {
    return { current: false, reason: 'revision-moved' }
  }
  if (now.patchHash !== review.subject_patch_hash) {
    return { current: false, reason: 'patch-changed' }
  }
  return { current: true }
}

export type ReviewCreateInput = {
  runId: string
  subject: { projectId: string; worktreePath: string | null; revision: string; patchHash: string }
  producer: ReviewParty
  reviewer: { agentId: string; provider: string | null }
  reviewTaskId: string | null
  policy?: ReviewPolicy
  producerTaskId?: string | null
}

export class ReviewStore {
  constructor(
    private readonly db: Database.Database,
    private readonly mintId: () => string
  ) {}

  create(input: ReviewCreateInput): ReviewRow {
    const id = this.mintId()
    this.db
      .prepare(
        `INSERT INTO reviews (id, run_id, subject_project_id, subject_worktree, subject_revision,
           subject_patch_hash, producer_agent_id, producer_provider, reviewer_agent_id,
           reviewer_provider, independence, review_task_id, policy, producer_task_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.runId,
        input.subject.projectId,
        input.subject.worktreePath,
        input.subject.revision,
        input.subject.patchHash,
        input.producer.agentId,
        input.producer.provider,
        input.reviewer.agentId,
        input.reviewer.provider,
        deriveIndependence(input.producer, input.reviewer),
        input.reviewTaskId,
        input.policy ?? 'any',
        input.producerTaskId ?? null
      )
    return this.get(id)!
  }

  get(id: string): ReviewRow | undefined {
    return this.db.prepare('SELECT * FROM reviews WHERE id = ?').get(id) as ReviewRow | undefined
  }

  /** The review a task is running, if it is one. */
  getByTask(taskId: string): ReviewRow | undefined {
    return this.db.prepare('SELECT * FROM reviews WHERE review_task_id = ?').get(taskId) as
      | ReviewRow
      | undefined
  }

  /** The reviewer's provider is only known once its turn has run, so independence is re-derived
   *  at settlement from what actually happened, not from what was hoped for at request time.
   *  Settles once: a late second settlement cannot rewrite what the first recorded. */
  settle(id: string, outcome: { status: 'completed' | 'failed'; reviewerProvider: string | null; findings: string }): ReviewRow | undefined {
    const review = this.get(id)
    if (!review) {
      return undefined
    }
    const independence = deriveIndependence(
      { agentId: review.producer_agent_id, provider: review.producer_provider },
      { agentId: review.reviewer_agent_id, provider: outcome.reviewerProvider }
    )
    this.db
      .prepare(
        `UPDATE reviews SET status = ?, reviewer_provider = ?, independence = ?, findings = ?,
           completed_at = datetime('now') WHERE id = ? AND status = 'requested'`
      )
      .run(outcome.status, outcome.reviewerProvider, independence, outcome.findings, id)
    return this.get(id)
  }

  /** Reviews this agent ran or whose subject it built, newest first. */
  listForAgent(agentId: string, limit: number): ReviewRow[] {
    return this.db
      .prepare(
        `SELECT * FROM reviews WHERE reviewer_agent_id = ? OR producer_agent_id = ?
           ORDER BY created_at DESC, rowid DESC LIMIT ?`
      )
      .all(agentId, agentId, limit) as ReviewRow[]
  }

  listForSubject(projectId: string, revision: string): ReviewRow[] {
    return this.db
      .prepare('SELECT * FROM reviews WHERE subject_project_id = ? AND subject_revision = ? ORDER BY created_at')
      .all(projectId, revision) as ReviewRow[]
  }
}
