/** Dispatching agent-assigned tasks as agent turns. They never enter the terminal pool. */
import type { OrchestrationDb } from './db'
import type { TaskRow } from './types'
import {
  parseAgentTaskResult,
  parseDelegationSubject,
  serializeAgentTaskResult,
  type AgentTaskOutcome,
  type AgentTaskRequest,
  type AgentTaskRunner
} from './agent-task-contract'
import { getRegisteredAgentTaskRunner } from './agent-task-runner-registry'
import { createDelegateTool } from './agent-delegate-tool'

/** Turns one agent may take on one task: the first, plus follow-ups after its children settle.
 *  Bounds an agent that keeps re-delegating instead of finishing. */
export const MAX_AGENT_TASK_ROUNDS = 4
/** Per-child reply excerpt carried into a follow-up; the full reply stays on the child task. */
const CHILD_REPLY_EXCERPT_CHARS = 4000

export type AgentTaskDispatchState = {
  /** Tasks whose turn is running now; guards against a second tick starting a second turn. */
  inFlight: Map<string, Promise<void>>
  /** Tasks already reported as waiting for a runner, so the log says it once, not every tick. */
  reportedWaiting: Set<string>
}

// Why process-wide: a stopped coordinator's turn keeps running, and the next coordinator in this
// process must see it as live rather than settle it as interrupted.
const processInFlight = new Map<string, Promise<void>>()

export function createAgentTaskDispatchState(): AgentTaskDispatchState {
  return { inFlight: processInFlight, reportedWaiting: new Set() }
}

function isSettled(task: TaskRow): boolean {
  return task.status === 'completed' || task.status === 'failed'
}

/** The children this task's agent delegated, i.e. the ones whose results it is owed. */
function delegatedChildren(db: OrchestrationDb, task: TaskRow): TaskRow[] {
  return db
    .listTasks()
    .filter(
      (child) =>
        child.parent_id === task.id &&
        child.requester_agent_id !== null &&
        child.requester_agent_id === task.assignee_agent_id
    )
}

function isAwaitingChildren(task: TaskRow): boolean {
  return (
    task.status === 'dispatched' &&
    task.assignee_agent_id !== null &&
    parseAgentTaskResult(task.result)?.awaitingChildren === true
  )
}

/** Turns a waiting task's children into the text its agent reads on the follow-up turn. */
export function composeChildrenReport(children: readonly TaskRow[]): string {
  const lines = ['The tasks you delegated have settled.', '']
  for (const child of children) {
    const result = parseAgentTaskResult(child.result)
    lines.push(`Task ${child.id} (${child.assignee_agent_id ?? 'unassigned'}): ${child.status}`)
    if (result?.outcome === 'completed') {
      lines.push(result.text.slice(0, CHILD_REPLY_EXCERPT_CHARS))
    } else if (result) {
      lines.push(`${result.outcome}: ${result.reason}`)
    }
    lines.push('')
  }
  lines.push('Continue the task with these results.')
  return lines.join('\n')
}

/**
 * An agent task left `dispatched` with no live turn in this process was interrupted (Orca restarted
 * or crashed mid-turn). It is settled as failed, never re-run: a repeated turn is a repeated effect.
 * A task WAITING for its children is not interrupted: its turn finished, and its children continue.
 */
export function settleInterruptedAgentTasks(db: OrchestrationDb, onLog: (msg: string) => void): void {
  for (const task of db.listTasks({ status: 'dispatched' })) {
    if (task.assignee_agent_id === null || processInFlight.has(task.id) || isAwaitingChildren(task)) {
      continue
    }
    db.updateTaskStatus(
      task.id,
      'failed',
      serializeAgentTaskResult({
        outcome: 'failed',
        reason: 'interrupted',
        conversationId: null,
        turnId: null
      })
    )
    onLog(`Task ${task.id} was mid-turn for agent ${task.assignee_agent_id} when Orca stopped; settled as interrupted.`)
  }
}

/** Agent turns running now. Waiting parents are `dispatched` but hold no slot: counting them would
 *  let N waiting parents starve the very children they are waiting for. */
export function runningAgentTurns(state: AgentTaskDispatchState): number {
  return state.inFlight.size
}

function settleAfterTurn(
  db: OrchestrationDb,
  task: TaskRow,
  outcome: AgentTaskOutcome,
  round: number,
  onLog: (msg: string) => void
): void {
  if (outcome.outcome !== 'completed') {
    db.updateTaskStatus(task.id, 'failed', serializeAgentTaskResult(outcome, { round }))
    onLog(`Agent ${task.assignee_agent_id} settled task ${task.id}: ${outcome.outcome}`)
    return
  }
  const open = delegatedChildren(db, task).filter((child) => !isSettled(child))
  if (open.length === 0) {
    db.updateTaskStatus(task.id, 'completed', serializeAgentTaskResult(outcome, { round }))
    onLog(`Agent ${task.assignee_agent_id} completed task ${task.id}`)
    return
  }
  db.updateTaskStatus(
    task.id,
    'dispatched',
    serializeAgentTaskResult(outcome, { round, awaitingChildren: true })
  )
  onLog(`Task ${task.id} waits for ${open.length} delegated task(s)`)
}

function startTurn(params: {
  db: OrchestrationDb
  task: TaskRow
  request: AgentTaskRequest
  round: number
  runner: AgentTaskRunner
  state: AgentTaskDispatchState
  onLog: (msg: string) => void
}): void {
  const { db, task, round, state, onLog } = params
  const settle = params
    .runner(params.request)
    .then((outcome) => settleAfterTurn(db, task, outcome, round, onLog))
    .catch((error: unknown) => {
      // Why: a runner that threw still owes the task a settlement, or it stays dispatched forever.
      db.updateTaskStatus(
        task.id,
        'failed',
        serializeAgentTaskResult(
          {
            outcome: 'failed',
            reason: error instanceof Error ? error.message : String(error),
            conversationId: null,
            turnId: null
          },
          { round }
        )
      )
    })
    .finally(() => {
      state.inFlight.delete(task.id)
    })
  state.inFlight.set(task.id, settle)
}

/** Starts up to `slots` agent turns without awaiting them; returns how many slots it used.
 *  Follow-ups for tasks whose delegated children have all settled go first: they finish work. */
export function dispatchAgentTasks(params: {
  db: OrchestrationDb
  tasks: readonly TaskRow[]
  slots: number
  state: AgentTaskDispatchState
  onLog: (msg: string) => void
  runner?: AgentTaskRunner | null
}): number {
  const { db, state, onLog } = params
  const runner = params.runner === undefined ? getRegisteredAgentTaskRunner() : params.runner
  let used = 0

  for (const task of db.listTasks({ status: 'dispatched' })) {
    if (used >= params.slots || !runner) {
      break
    }
    if (!isAwaitingChildren(task) || state.inFlight.has(task.id)) {
      continue
    }
    const children = delegatedChildren(db, task)
    if (!children.every(isSettled)) {
      continue
    }
    const previous = parseAgentTaskResult(task.result)
    const round = (previous?.round ?? 1) + 1
    if (round > MAX_AGENT_TASK_ROUNDS || previous?.outcome !== 'completed') {
      db.updateTaskStatus(
        task.id,
        'failed',
        serializeAgentTaskResult(
          {
            outcome: 'failed',
            reason: 'agent-rounds-exceeded',
            conversationId: previous?.outcome === 'completed' ? previous.conversationId : null,
            turnId: null
          },
          { round: round - 1 }
        )
      )
      continue
    }
    used += 1
    const subject = parseDelegationSubject(task.subject)
    startTurn({
      db,
      task,
      round,
      runner,
      state,
      onLog,
      request: {
        taskId: task.id,
        agentId: task.assignee_agent_id!,
        spec: composeChildrenReport(children),
        subject: subject.kind === 'subject' ? subject.subject : null,
        tools: [createDelegateTool(db, task)],
        continueConversationId: previous.conversationId
      }
    })
  }

  for (const task of params.tasks) {
    if (used >= params.slots) {
      break
    }
    const agentId = task.assignee_agent_id
    if (!agentId || state.inFlight.has(task.id)) {
      continue
    }
    if (!runner) {
      if (!state.reportedWaiting.has(task.id)) {
        state.reportedWaiting.add(task.id)
        onLog(`Task ${task.id} is assigned to agent ${agentId}; this host cannot run agent turns, so it waits.`)
      }
      continue
    }
    const subject = parseDelegationSubject(task.subject)
    if (subject.kind === 'unreadable') {
      db.updateTaskStatus(
        task.id,
        'failed',
        serializeAgentTaskResult({
          outcome: 'refused',
          reason: 'subject-unreadable',
          detail: 'The task names a subject that could not be read.'
        })
      )
      continue
    }
    db.updateTaskStatus(task.id, 'dispatched')
    used += 1
    startTurn({
      db,
      task,
      round: 1,
      runner,
      state,
      onLog,
      request: {
        taskId: task.id,
        agentId,
        spec: task.spec,
        subject: subject.kind === 'subject' ? subject.subject : null,
        tools: [createDelegateTool(db, task)]
      }
    })
  }
  return used
}
