// A person's approval of an exact commit, enforced where the task's effect happens, on a real
// repository: the effect runs only while the approved commit is still the one in the worktree.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'
import type { AgentTaskRequest, AgentTaskRunner } from './agent-task-contract'
import { createAgentTaskDispatchState, dispatchAgentTasks } from './coordinator-agent-tasks'
import { dispatchTaskToWorker } from './coordinator-task-dispatch'
import type { CoordinatorRuntime } from './coordinator-runtime-contract'
import { captureRevisionSubject } from './review-subject-capture'
import { decideSubjectGate, rebindSubjectGate, type GateSubject } from './subject-bound-gates'

const PROJECT = 'github:acme/api'
let repo = ''
let db: OrchestrationDb

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
}

function commit(content: string): void {
  writeFileSync(join(repo, 'a.txt'), content)
  git(['add', 'a.txt'])
  git(['commit', '-qm', content.trim().slice(0, 20)])
}

async function subjectNow(): Promise<GateSubject> {
  const captured = await captureRevisionSubject(repo)
  if (captured.outcome !== 'captured') {
    throw new Error('fixture repository unreadable')
  }
  return { projectId: PROJECT, worktreePath: repo, revision: captured.subject.revision, patchHash: captured.subject.patchHash }
}

async function gatedTask(requirement: 'none' | 'any' | 'independent' = 'none') {
  const task = db.createTask({ spec: 'ship the fix', assigneeAgentId: 'shipper' })
  const subject = await subjectNow()
  const gate = db.createGate({ taskId: task.id, question: 'Ship this commit?', subject, reviewRequirement: requirement })
  return { task, gate, subject }
}

const observedOf = (subject: GateSubject) => ({ revision: subject.revision, patchHash: subject.patchHash })

async function runReady(): Promise<AgentTaskRequest[]> {
  const ran: AgentTaskRequest[] = []
  const runner: AgentTaskRunner = async (request) => {
    ran.push(request)
    return { outcome: 'completed', conversationId: 'c', turnId: 't', text: 'shipped', provider: 'claude' }
  }
  const state = createAgentTaskDispatchState()
  dispatchAgentTasks({ db, tasks: db.listTasks({ status: 'ready' }), slots: 4, state, onLog: () => {}, runner })
  await Promise.all([...state.inFlight.values()])
  return ran
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'orca-subject-gate-'))
  git(['init', '-q', '-b', 'main'])
  git(['config', 'user.email', 'g@test.invalid'])
  git(['config', 'user.name', 'G'])
  git(['config', 'commit.gpgsign', 'false'])
  commit('one\n')
  db = new OrchestrationDb(':memory:')
})

afterEach(() => {
  db.close()
  rmSync(repo, { recursive: true, force: true })
})

describe('a subject-bound gate', () => {
  it('holds the effect until a person approves the exact commit they were shown, then runs it once', async () => {
    const { task, gate, subject } = await gatedTask()

    expect(await runReady()).toEqual([])
    expect(
      await decideSubjectGate(db, gate.id, { decision: 'approved', observed: { revision: subject.revision, patchHash: 'other' } }, captureRevisionSubject)
    ).toMatchObject({ outcome: 'refused', reason: 'not-what-was-shown' })
    expect(db.getTask(task.id)?.status).toBe('blocked')

    const decided = await decideSubjectGate(db, gate.id, { decision: 'approved', observed: observedOf(subject) }, captureRevisionSubject)

    expect(decided).toMatchObject({ outcome: 'decided', gate: { decision: 'approved', status: 'resolved' } })
    expect((await runReady()).map((request) => request.taskId)).toEqual([task.id])
    expect(db.getTask(task.id)?.status).toBe('completed')
  }, 90_000)

  it('does not let an approval outlive the commit it approved, and asks again about the new one', async () => {
    const { task, gate, subject } = await gatedTask()
    await decideSubjectGate(db, gate.id, { decision: 'approved', observed: observedOf(subject) }, captureRevisionSubject)
    commit('one\ntwo\n')

    expect(await runReady()).toEqual([])
    expect(db.getGate(gate.id)).toMatchObject({ status: 'pending', decision: 'stale' })
    expect(db.getTask(task.id)?.status).toBe('blocked')
    // The old approval cannot be replayed against the new commit.
    expect(
      await decideSubjectGate(db, gate.id, { decision: 'approved', observed: observedOf(subject) }, captureRevisionSubject)
    ).toMatchObject({ outcome: 'refused', reason: 'subject-moved' })

    const rebound = await rebindSubjectGate(db, gate.id, captureRevisionSubject)
    const now = await subjectNow()
    expect(rebound).toMatchObject({ outcome: 'decided', gate: { decision: null } })
    expect(JSON.parse(db.getGate(gate.id)!.subject!).revision).toBe(now.revision)
    await decideSubjectGate(db, gate.id, { decision: 'approved', observed: observedOf(now) }, captureRevisionSubject)
    expect((await runReady()).map((request) => request.taskId)).toEqual([task.id])
  }, 120_000)

  it('never runs a rejected task, and cannot be decided twice', async () => {
    const { task, gate, subject } = await gatedTask()

    await decideSubjectGate(db, gate.id, { decision: 'rejected', observed: observedOf(subject) }, captureRevisionSubject)

    expect(db.getTask(task.id)?.status).toBe('failed')
    expect(await runReady()).toEqual([])
    expect(
      await decideSubjectGate(db, gate.id, { decision: 'approved', observed: observedOf(subject) }, captureRevisionSubject)
    ).toMatchObject({ outcome: 'refused', reason: 'already-decided' })
  }, 90_000)

  it('authorizes only its own task', async () => {
    const a = await gatedTask()
    const b = await gatedTask()

    await decideSubjectGate(db, a.gate.id, { decision: 'approved', observed: observedOf(a.subject) }, captureRevisionSubject)

    expect((await runReady()).map((request) => request.taskId)).toEqual([a.task.id])
    expect(db.getTask(b.task.id)?.status).toBe('blocked')
  }, 90_000)

  it('requires a current approving review of the same commit when asked, and an independent one when asked', async () => {
    const { gate, subject } = await gatedTask('independent')
    const approve = { decision: 'approved' as const, observed: observedOf(subject) }
    const review = (independence: 'provider' | 'none') => {
      const store = db.reviews()
      const row = store.create({
        runId: 'legacy',
        subject,
        producer: { agentId: 'builder', provider: 'codex' },
        reviewer: { agentId: 'reviewer', provider: null },
        reviewTaskId: null
      })
      store.settle(row.id, {
        status: 'completed',
        reviewerProvider: independence === 'provider' ? 'claude' : 'codex',
        findings: JSON.stringify({ schema: 'orca.review-findings/1', kind: 'structured', verdict: 'approve', findings: [], blocking: false })
      })
    }

    expect(await decideSubjectGate(db, gate.id, approve, captureRevisionSubject)).toMatchObject({ reason: 'review-missing' })
    review('none')
    expect(await decideSubjectGate(db, gate.id, approve, captureRevisionSubject)).toMatchObject({ reason: 'review-not-independent' })
    review('provider')
    expect(await decideSubjectGate(db, gate.id, approve, captureRevisionSubject)).toMatchObject({ outcome: 'decided' })
  }, 90_000)

  it('stops a terminal worker from being told to act on a commit that moved after approval', async () => {
    const task = db.createTask({ spec: 'ship the fix' })
    const subject = await subjectNow()
    const gate = db.createGate({ taskId: task.id, question: 'Ship?', subject })
    await decideSubjectGate(db, gate.id, { decision: 'approved', observed: observedOf(subject) }, captureRevisionSubject)
    commit('one\nthree\n')
    const prompts: string[] = []
    const runtime = {
      async sendTerminalAgentPrompt(_handle: string, prompt: string) {
        prompts.push(prompt)
        return {}
      }
    } as unknown as CoordinatorRuntime

    const result = await dispatchTaskToWorker({
      db,
      runtime,
      task: db.getTask(task.id)!,
      targetHandle: 'term_worker',
      baseDrift: null,
      coordinatorHandle: 'coord',
      worktree: undefined,
      onLog: () => {},
      onCircuitBroken: () => {}
    })

    expect(result).toBe('approval-refused')
    expect(prompts).toEqual([])
    expect(db.getGate(gate.id)?.decision).toBe('stale')
  }, 90_000)
})
