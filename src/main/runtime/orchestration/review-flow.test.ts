// The review flow end to end inside orchestration: request -> the review task runs as the reviewer's
// turn, away from the producer's provider -> the review settles from what actually happened.
import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'
import {
  serializeAgentTaskResult,
  type AgentTaskOutcome,
  type AgentTaskRequest,
  type AgentTaskRunner
} from './agent-task-contract'
import { createAgentTaskDispatchState, dispatchAgentTasks, settleInterruptedAgentTasks } from './coordinator-agent-tasks'
import { requestReview, type ReviewRequestInput } from './review-request'
import type { RevisionSubjectCapture } from './review-subject-capture'
import { judgeReviewCurrency } from './review-records'
import { parseReviewFindings, REVIEW_PATCH_MAX_CHARS } from './review-findings'

const REV_A = 'a'.repeat(40)
const REV_B = 'b'.repeat(40)
const PROJECT = 'github:acme/api'

const captured = (patch = '+fixed the ladder step\n'): RevisionSubjectCapture => ({
  outcome: 'captured',
  subject: { revision: REV_A, patchHash: 'hash-a', patch }
})
const approve = '```json\n{"verdict":"approve","findings":[{"severity":"minor","summary":"name it"}]}\n```'

let db: OrchestrationDb | undefined

afterEach(() => {
  db?.close()
  db = undefined
})

function open(): OrchestrationDb {
  db = new OrchestrationDb(':memory:')
  return db
}

/** A completed task built by `agent` on `provider`, exactly as the coordinator records one. */
function builtBy(store: OrchestrationDb, agent: string, provider: string | null): string {
  const task = store.createTask({ spec: 'fix the migration', assigneeAgentId: agent })
  store.updateTaskStatus(
    task.id,
    'completed',
    serializeAgentTaskResult({ outcome: 'completed', conversationId: 'c', turnId: 't', text: 'done', provider })
  )
  return task.id
}

function input(overrides: Partial<ReviewRequestInput> = {}): ReviewRequestInput {
  return { reviewerAgentId: 'reviewer', projectId: PROJECT, worktreePath: '/w/api', policy: 'independent', ...overrides }
}

async function runReady(store: OrchestrationDb, runner: AgentTaskRunner): Promise<void> {
  const state = createAgentTaskDispatchState()
  dispatchAgentTasks({ db: store, tasks: store.listTasks({ status: 'ready' }), slots: 4, state, onLog: () => {}, runner })
  await Promise.all([...state.inFlight.values()])
}

describe('requesting a review', () => {
  it('binds the task and the review to the captured revision and the recorded producer', async () => {
    const store = open()
    const producerTaskId = builtBy(store, 'builder', 'codex')

    const outcome = await requestReview(store, input({ producerTaskId }), async () => captured())

    expect(outcome.outcome).toBe('requested')
    if (outcome.outcome !== 'requested') {
      return
    }
    expect(outcome.review).toMatchObject({
      subject_revision: REV_A,
      subject_patch_hash: 'hash-a',
      producer_agent_id: 'builder',
      producer_provider: 'codex',
      producer_task_id: producerTaskId,
      policy: 'independent',
      review_task_id: outcome.task.id,
      status: 'requested'
    })
    expect(outcome.task).toMatchObject({ assignee_agent_id: 'reviewer', requester_agent_id: null })
    expect(outcome.task.spec).toContain('+fixed the ladder step')
    expect(JSON.parse(outcome.task.subject!)).toEqual({ projectId: PROJECT, worktreePath: '/w/api', revision: REV_A })
  })

  it('refuses an independent review nobody can keep independent, and writes nothing', async () => {
    const store = open()
    const unknownProvider = builtBy(store, 'builder', null)
    const selfBuilt = builtBy(store, 'reviewer', 'codex')
    const before = store.listTasks().length

    expect(await requestReview(store, input(), async () => captured())).toMatchObject({
      outcome: 'refused',
      reason: 'producer-unknown'
    })
    expect(await requestReview(store, input({ producerTaskId: unknownProvider }), async () => captured())).toMatchObject({
      reason: 'producer-unknown'
    })
    expect(await requestReview(store, input({ producerTaskId: selfBuilt }), async () => captured())).toMatchObject({
      reason: 'reviewer-is-producer'
    })
    expect(store.listTasks()).toHaveLength(before)
  })

  it('records a non-independent review as asked, with independence left to the evidence', async () => {
    const store = open()

    const outcome = await requestReview(store, input({ policy: 'any' }), async () => captured())

    expect(outcome).toMatchObject({ outcome: 'requested', review: { independence: 'unknown', policy: 'any' } })
  })

  it('refuses a producer that has not finished, one from another project, and one that does not exist', async () => {
    const store = open()
    const running = store.createTask({ spec: 'still going', assigneeAgentId: 'builder' })
    const elsewhere = store.createTask({
      spec: 'billing',
      assigneeAgentId: 'builder',
      subject: { projectId: 'github:acme/billing', worktreePath: null, revision: null }
    })
    store.updateTaskStatus(elsewhere.id, 'completed', serializeAgentTaskResult({ outcome: 'completed', conversationId: 'c', turnId: 't', text: 'x', provider: 'codex' }))

    expect(await requestReview(store, input({ producerTaskId: running.id }), async () => captured())).toMatchObject({ reason: 'producer-task-unsettled' })
    expect(await requestReview(store, input({ producerTaskId: elsewhere.id }), async () => captured())).toMatchObject({ reason: 'producer-task-other-project' })
    expect(await requestReview(store, input({ producerTaskId: 'task_none' }), async () => captured())).toMatchObject({ reason: 'producer-task-not-found' })
  })

  it('refuses a subject it cannot read, and one too large to show whole', async () => {
    const store = open()
    const producerTaskId = builtBy(store, 'builder', 'codex')

    expect(
      await requestReview(store, input({ producerTaskId }), async () => ({ outcome: 'unreadable', reason: 'merge-commit', detail: 'merge' }))
    ).toMatchObject({ reason: 'subject-unreadable' })
    expect(
      await requestReview(store, input({ producerTaskId }), async () => captured('x'.repeat(REVIEW_PATCH_MAX_CHARS + 1)))
    ).toMatchObject({ reason: 'patch-too-large' })
  })

  it('writes the task and the review together or not at all', () => {
    const store = open()
    const before = store.listTasks().length

    expect(() =>
      store.createReviewTask(
        { spec: 'review', assigneeAgentId: 'reviewer' },
        {
          subject: { projectId: PROJECT, worktreePath: null, revision: REV_A, patchHash: 'h' },
          producer: { agentId: null, provider: null },
          reviewer: { agentId: null as unknown as string, provider: null }
        }
      )
    ).toThrow()
    expect(store.listTasks()).toHaveLength(before)
  })
})

describe('running a review', () => {
  async function requested(store: OrchestrationDb, provider: string, policy: 'independent' | 'any' = 'independent') {
    const producerTaskId = builtBy(store, 'builder', provider)
    const outcome = await requestReview(store, input({ producerTaskId, policy }), async () => captured())
    if (outcome.outcome !== 'requested') {
      throw new Error(`expected a request, got ${outcome.reason}`)
    }
    return outcome
  }

  it('runs away from the producer’s provider, without tools, and settles independent', async () => {
    const store = open()
    const { review } = await requested(store, 'codex')
    const seen: AgentTaskRequest[] = []

    await runReady(store, async (request) => {
      seen.push(request)
      return { outcome: 'completed', conversationId: 'c2', turnId: 't2', text: `Reviewed.\n${approve}`, provider: 'claude' }
    })

    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ agentId: 'reviewer', excludeProviders: ['codex'], tools: [] })
    const settled = store.reviews().get(review.id)!
    expect(settled).toMatchObject({ status: 'completed', reviewer_provider: 'claude', independence: 'independent' })
    expect(parseReviewFindings(settled.findings)).toMatchObject({ kind: 'structured', verdict: 'approve', blocking: false })
  })

  it('names a same-provider review degraded, from the provider that actually ran it', async () => {
    const store = open()
    const { review } = await requested(store, 'claude', 'any')
    const seen: AgentTaskRequest[] = []

    await runReady(store, async (request) => {
      seen.push(request)
      return { outcome: 'completed', conversationId: 'c', turnId: 't', text: approve, provider: 'claude' }
    })

    expect(seen[0].excludeProviders).toBeUndefined()
    expect(store.reviews().get(review.id)).toMatchObject({ status: 'completed', independence: 'degraded-same-provider' })
  })

  it('never records a review that did not run as completed', async () => {
    const store = open()
    const refused = await requested(store, 'codex')
    const failed = await requested(store, 'codex')
    const outcomes = new Map<string, AgentTaskOutcome>([
      [refused.task.id, { outcome: 'refused', reason: 'no-provider', detail: 'codex: excluded; claude: quota' }],
      [failed.task.id, { outcome: 'failed', reason: 'turn-ended', conversationId: 'c', turnId: 't', provider: 'claude' }]
    ])

    await runReady(store, async (request) => outcomes.get(request.taskId)!)

    expect(store.reviews().get(refused.review.id)).toMatchObject({ status: 'failed' })
    expect(parseReviewFindings(store.reviews().get(refused.review.id)!.findings)).toMatchObject({ kind: 'failed', reason: 'no-provider' })
    expect(store.reviews().get(failed.review.id)).toMatchObject({ status: 'failed', reviewer_provider: 'claude' })
  })

  it('settles a review whose turn was interrupted by a restart as failed', async () => {
    const store = open()
    const { review, task } = await requested(store, 'codex')
    store.updateTaskStatus(task.id, 'dispatched')

    settleInterruptedAgentTasks(store, () => {})

    expect(store.reviews().get(review.id)).toMatchObject({ status: 'failed' })
    expect(parseReviewFindings(store.reviews().get(review.id)!.findings)).toMatchObject({ reason: 'interrupted' })
  })

  it('stays evidence for the revision it saw after the subject moves, and is not current for the new one', async () => {
    const store = open()
    const { review } = await requested(store, 'codex')
    // The subject moves while the review runs; the result still arrives afterwards.
    await runReady(store, async () => ({ outcome: 'completed', conversationId: 'c', turnId: 't', text: approve, provider: 'claude' }))

    const settled = store.reviews().get(review.id)!

    expect(settled.status).toBe('completed')
    expect(judgeReviewCurrency(settled, { revision: REV_B, patchHash: 'hash-b' })).toEqual({ current: false, reason: 'revision-moved' })
    expect(judgeReviewCurrency(settled, { revision: REV_A, patchHash: 'hash-a' })).toEqual({ current: true })
    expect(store.reviews().listForSubject(PROJECT, REV_A).map((row) => row.id)).toEqual([review.id])
    expect(store.reviews().listForSubject(PROJECT, REV_B)).toEqual([])
  })
})
