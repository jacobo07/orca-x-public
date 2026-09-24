/** Dispatching agent-assigned tasks as agent turns. They never enter the terminal pool. */
import type { OrchestrationDb } from './db'
import type { TaskRow } from './types'
import {
  parseDelegationSubject,
  serializeAgentTaskResult,
  type AgentTaskRunner
} from './agent-task-contract'
import { getRegisteredAgentTaskRunner } from './agent-task-runner-registry'

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

/**
 * An agent task left `dispatched` with no live turn in this process was interrupted (Orca restarted
 * or crashed mid-turn). It is settled as failed, never re-run: a repeated turn is a repeated effect.
 */
export function settleInterruptedAgentTasks(db: OrchestrationDb, onLog: (msg: string) => void): void {
  for (const task of db.listTasks({ status: 'dispatched' })) {
    if (task.assignee_agent_id === null || processInFlight.has(task.id)) {
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

/** Starts up to `slots` agent turns without awaiting them; returns how many slots it used. */
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
    const settle = runner({
      taskId: task.id,
      agentId,
      spec: task.spec,
      subject: subject.kind === 'subject' ? subject.subject : null
    })
      .then((outcome) => {
        db.updateTaskStatus(
          task.id,
          outcome.outcome === 'completed' ? 'completed' : 'failed',
          serializeAgentTaskResult(outcome)
        )
        onLog(`Agent ${agentId} settled task ${task.id}: ${outcome.outcome}`)
      })
      .catch((error: unknown) => {
        // Why: a runner that threw still owes the task a settlement, or it stays dispatched forever.
        db.updateTaskStatus(
          task.id,
          'failed',
          serializeAgentTaskResult({
            outcome: 'failed',
            reason: error instanceof Error ? error.message : String(error),
            conversationId: null,
            turnId: null
          })
        )
      })
      .finally(() => {
        state.inFlight.delete(task.id)
      })
    state.inFlight.set(task.id, settle)
  }
  return used
}
