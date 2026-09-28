// Asking an agent to review an exact revision. Orca decides everything a review's authority rests
// on — the subject (captured from git), the producer (read from a task's recorded result) and the
// policy's feasibility — before any turn runs. The caller names only who reviews and what.
import type { OrchestrationDb } from './db'
import type { TaskRow } from './types'
import { parseAgentTaskResult, parseDelegationSubject } from './agent-task-contract'
import { captureRevisionSubject, type RevisionSubjectCapture } from './review-subject-capture'
import { composeReviewSpec, REVIEW_PATCH_MAX_CHARS } from './review-findings'
import type { ReviewParty, ReviewPolicy, ReviewRow } from './review-records'

export type ReviewRequestInput = {
  runId?: string
  reviewerAgentId: string
  projectId: string
  worktreePath: string
  revision?: string
  /** The task that built the subject; its recorded result names the producer's agent and provider. */
  producerTaskId?: string
  policy: ReviewPolicy
}

export type ReviewRequestRefusal =
  | 'producer-task-not-found'
  | 'producer-task-unsettled'
  | 'producer-task-other-project'
  /** `independent` cannot be guaranteed without knowing who built the subject. */
  | 'producer-unknown'
  | 'reviewer-is-producer'
  | 'subject-unreadable'
  | 'patch-too-large'

export type ReviewRequestOutcome =
  | { outcome: 'requested'; review: ReviewRow; task: TaskRow }
  | { outcome: 'refused'; reason: ReviewRequestRefusal; detail: string }

type Producer = { party: ReviewParty; taskId: string | null }

function readProducer(
  db: OrchestrationDb,
  input: ReviewRequestInput
): Producer | Extract<ReviewRequestOutcome, { outcome: 'refused' }> {
  if (!input.producerTaskId) {
    return { party: { agentId: null, provider: null }, taskId: null }
  }
  const task = db.getTask(input.producerTaskId)
  if (!task) {
    return { outcome: 'refused', reason: 'producer-task-not-found', detail: `No task ${input.producerTaskId}.` }
  }
  if (task.status !== 'completed') {
    return {
      outcome: 'refused',
      reason: 'producer-task-unsettled',
      detail: `Task ${task.id} is ${task.status}; review what it produced once it has completed.`
    }
  }
  const subject = parseDelegationSubject(task.subject)
  const subjectProject = subject.kind === 'subject' ? subject.subject.projectId : null
  if (subject.kind === 'unreadable' || (subjectProject !== null && subjectProject !== input.projectId)) {
    return {
      outcome: 'refused',
      reason: 'producer-task-other-project',
      detail: `Task ${task.id} worked on ${subjectProject ?? 'an unreadable subject'}, not ${input.projectId}.`
    }
  }
  const result = parseAgentTaskResult(task.result)
  const provider = result && result.outcome !== 'refused' ? (result.provider ?? null) : null
  return { party: { agentId: task.assignee_agent_id, provider }, taskId: task.id }
}

export async function requestReview(
  db: OrchestrationDb,
  input: ReviewRequestInput,
  capture: (worktreePath: string, revision?: string) => Promise<RevisionSubjectCapture> = captureRevisionSubject
): Promise<ReviewRequestOutcome> {
  const producer = readProducer(db, input)
  if ('outcome' in producer) {
    return producer
  }
  if (input.policy === 'independent') {
    if (producer.party.agentId !== null && producer.party.agentId === input.reviewerAgentId) {
      return {
        outcome: 'refused',
        reason: 'reviewer-is-producer',
        detail: `${input.reviewerAgentId} built this; an independent review needs another agent.`
      }
    }
    if (producer.party.agentId === null || producer.party.provider === null) {
      return {
        outcome: 'refused',
        reason: 'producer-unknown',
        detail: 'Orca does not know which agent and provider built this, so it cannot keep the review independent of them.'
      }
    }
  }

  const captured = await capture(input.worktreePath, input.revision)
  if (captured.outcome !== 'captured') {
    return { outcome: 'refused', reason: 'subject-unreadable', detail: `${captured.reason}: ${captured.detail}` }
  }
  const { subject } = captured
  if (subject.patch.length > REVIEW_PATCH_MAX_CHARS) {
    return {
      outcome: 'refused',
      reason: 'patch-too-large',
      detail: `The patch is ${subject.patch.length} characters; a review is shown the whole patch, up to ${REVIEW_PATCH_MAX_CHARS}.`
    }
  }

  // Why no await between capture and write: nothing else can run in this process until both rows exist.
  const created = db.createReviewTask(
    {
      spec: composeReviewSpec({
        projectId: input.projectId,
        revision: subject.revision,
        patchHash: subject.patchHash,
        patch: subject.patch
      }),
      taskTitle: `Review ${subject.revision.slice(0, 12)}`,
      assigneeAgentId: input.reviewerAgentId,
      subject: { projectId: input.projectId, worktreePath: input.worktreePath, revision: subject.revision },
      ...(input.runId ? { runId: input.runId } : {})
    },
    {
      subject: {
        projectId: input.projectId,
        worktreePath: input.worktreePath,
        revision: subject.revision,
        patchHash: subject.patchHash
      },
      producer: producer.party,
      reviewer: { agentId: input.reviewerAgentId, provider: null },
      policy: input.policy,
      producerTaskId: producer.taskId
    }
  )
  return { outcome: 'requested', review: created.review, task: created.task }
}
