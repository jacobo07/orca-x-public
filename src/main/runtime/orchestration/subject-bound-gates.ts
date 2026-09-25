// A human approval over an exact subject, enforced where the effect happens. A decision gate bound
// to a subject authorizes running its task only while the worktree still holds exactly the revision
// and patch the person approved — and, when the gate asks for it, only while a current review of
// that same subject says it may ship. Every check is repeated immediately before the effect, because
// the subject can move between the approval and the dispatch.
import type { OrchestrationDb } from './db'
import type { DecisionGateRow } from './types'
import type { RevisionSubjectCapture } from './review-subject-capture'
import { judgeReviewCurrency } from './review-records'
import { parseReviewFindings } from './review-findings'

export type GateSubject = { projectId: string; worktreePath: string; revision: string; patchHash: string }
/** `any`: a completed, non-blocking, approving review of this exact subject. `independent`: and it
 *  was independent of whoever built it. */
export type GateReviewRequirement = 'none' | 'any' | 'independent'
export type GateDecision = 'approved' | 'rejected' | 'stale'

export type SubjectRefusal =
  | 'subject-unreadable'
  | 'subject-moved'
  | 'review-missing'
  | 'review-not-independent'

export function parseGateSubject(raw: string | null): GateSubject | null {
  if (!raw) {
    return null
  }
  try {
    const value = JSON.parse(raw) as Partial<GateSubject>
    const fields = [value.projectId, value.worktreePath, value.revision, value.patchHash]
    return fields.every((field) => typeof field === 'string' && field.length > 0) ? (value as GateSubject) : null
  } catch {
    return null
  }
}

/** Whether a review of exactly this subject lets it through, under the gate's requirement. */
export function judgeReviewRequirement(
  db: OrchestrationDb,
  subject: GateSubject,
  requirement: GateReviewRequirement
): { ok: true } | { ok: false; reason: 'review-missing' | 'review-not-independent' } {
  if (requirement === 'none') {
    return { ok: true }
  }
  const passing = db
    .reviews()
    .listForSubject(subject.projectId, subject.revision)
    .filter((review) => {
      if (review.status !== 'completed') {
        return false
      }
      if (!judgeReviewCurrency(review, { revision: subject.revision, patchHash: subject.patchHash }).current) {
        return false
      }
      const findings = parseReviewFindings(review.findings)
      return findings?.kind === 'structured' && findings.verdict === 'approve' && !findings.blocking
    })
  if (passing.length === 0) {
    return { ok: false, reason: 'review-missing' }
  }
  if (requirement === 'independent' && !passing.some((review) => review.independence === 'independent')) {
    return { ok: false, reason: 'review-not-independent' }
  }
  return { ok: true }
}

/** The subject as it is now, compared with the one the gate names. */
export function judgeSubjectNow(
  subject: GateSubject,
  now: RevisionSubjectCapture
): { ok: true } | { ok: false; reason: 'subject-unreadable' | 'subject-moved' } {
  if (now.outcome !== 'captured') {
    return { ok: false, reason: 'subject-unreadable' }
  }
  return now.subject.revision === subject.revision && now.subject.patchHash === subject.patchHash
    ? { ok: true }
    : { ok: false, reason: 'subject-moved' }
}

export type GateDecisionOutcome =
  | { outcome: 'decided'; gate: DecisionGateRow }
  | {
      outcome: 'refused'
      reason: SubjectRefusal | 'not-subject-bound' | 'already-decided' | 'not-what-was-shown' | 'gate-not-found'
      detail: string
    }

/**
 * A person decides a subject-bound gate. `observed` is the subject the person was shown: the
 * decision authorizes THAT, so a gate whose subject changed under the dialog is refused rather than
 * approving something nobody looked at. Approval also re-reads git and the review requirement now.
 */
export async function decideSubjectGate(
  db: OrchestrationDb,
  gateId: string,
  input: { decision: 'approved' | 'rejected'; observed: { revision: string; patchHash: string } },
  capture: (worktreePath: string) => Promise<RevisionSubjectCapture>
): Promise<GateDecisionOutcome> {
  const gate = db.getGate(gateId)
  if (!gate) {
    return { outcome: 'refused', reason: 'gate-not-found', detail: `No gate ${gateId}.` }
  }
  const subject = parseGateSubject(gate.subject)
  if (!subject) {
    return { outcome: 'refused', reason: 'not-subject-bound', detail: 'This gate is not bound to a subject.' }
  }
  if (gate.status !== 'pending') {
    return { outcome: 'refused', reason: 'already-decided', detail: `This gate is ${gate.decision ?? gate.status}.` }
  }
  if (input.observed.revision !== subject.revision || input.observed.patchHash !== subject.patchHash) {
    return {
      outcome: 'refused',
      reason: 'not-what-was-shown',
      detail: 'The subject shown is not the one this gate asks about; look at it again.'
    }
  }
  if (input.decision === 'rejected') {
    return { outcome: 'decided', gate: db.decideSubjectGate(gateId, 'rejected') }
  }
  const now = judgeSubjectNow(subject, await capture(subject.worktreePath))
  if (!now.ok) {
    return { outcome: 'refused', reason: now.reason, detail: describeRefusal(now.reason) }
  }
  const review = judgeReviewRequirement(db, subject, gate.review_requirement ?? 'none')
  if (!review.ok) {
    return { outcome: 'refused', reason: review.reason, detail: describeRefusal(review.reason) }
  }
  // Why no await after the checks above: nothing else in this process runs before the decision lands.
  return { outcome: 'decided', gate: db.decideSubjectGate(gateId, 'approved') }
}

/** After a stale approval or a moved worktree: point the pending gate at the commit as it is now.
 *  Authorizes nothing; the person still decides, about what they are then shown. */
export async function rebindSubjectGate(
  db: OrchestrationDb,
  gateId: string,
  capture: (worktreePath: string) => Promise<RevisionSubjectCapture>
): Promise<GateDecisionOutcome> {
  const gate = db.getGate(gateId)
  const subject = gate ? parseGateSubject(gate.subject) : null
  if (!gate || !subject) {
    return { outcome: 'refused', reason: gate ? 'not-subject-bound' : 'gate-not-found', detail: `Gate ${gateId}.` }
  }
  if (gate.status !== 'pending') {
    return { outcome: 'refused', reason: 'already-decided', detail: `This gate is ${gate.decision ?? gate.status}.` }
  }
  const now = await capture(subject.worktreePath)
  if (now.outcome !== 'captured') {
    return { outcome: 'refused', reason: 'subject-unreadable', detail: describeRefusal('subject-unreadable') }
  }
  const rebound = db.rebindSubjectGate(gateId, {
    ...subject,
    revision: now.subject.revision,
    patchHash: now.subject.patchHash
  })
  return { outcome: 'decided', gate: rebound! }
}

export function hasSubjectBoundGate(db: OrchestrationDb, taskId: string): boolean {
  return db.listGates({ taskId }).some((gate) => parseGateSubject(gate.subject) !== null)
}

export type GatedEffectAuthority =
  | { authorized: true }
  | { authorized: false; reason: SubjectRefusal | 'rejected' | 'awaiting-approval'; gateId: string }

/**
 * Called immediately before a task's effect (its agent turn or its terminal prompt). A task with no
 * subject-bound gate is not this module's business. An approved gate is re-judged against git and
 * the review requirement NOW; if it no longer holds, the approval becomes stale — it stays on record
 * as what was approved, and the task waits for a new decision.
 */
export async function authorizeGatedEffect(
  db: OrchestrationDb,
  taskId: string,
  capture: (worktreePath: string) => Promise<RevisionSubjectCapture>
): Promise<GatedEffectAuthority> {
  const gates = db.listGates({ taskId }).filter((gate) => parseGateSubject(gate.subject) !== null)
  const latest = gates.at(-1)
  if (!latest) {
    return { authorized: true }
  }
  if (latest.decision === 'rejected') {
    return { authorized: false, reason: 'rejected', gateId: latest.id }
  }
  if (latest.decision !== 'approved') {
    return { authorized: false, reason: 'awaiting-approval', gateId: latest.id }
  }
  const subject = parseGateSubject(latest.subject)!
  const now = judgeSubjectNow(subject, await capture(subject.worktreePath))
  const verdict = now.ok ? judgeReviewRequirement(db, subject, latest.review_requirement ?? 'none') : now
  if (!verdict.ok) {
    db.staleSubjectGate(latest.id)
    return { authorized: false, reason: verdict.reason, gateId: latest.id }
  }
  return { authorized: true }
}

export function describeRefusal(reason: SubjectRefusal): string {
  switch (reason) {
    case 'subject-unreadable':
      return 'Orca cannot read the approved commit in its worktree now, so it cannot confirm it is unchanged.'
    case 'subject-moved':
      return 'The worktree no longer holds the commit that was approved.'
    case 'review-missing':
      return 'No completed, approving review of this exact commit exists.'
    case 'review-not-independent':
      return 'The approving reviews of this commit were not independent of whoever built it.'
  }
}
