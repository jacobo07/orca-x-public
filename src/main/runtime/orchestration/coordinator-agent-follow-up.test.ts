import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'
import { Coordinator } from './coordinator'
import type { CoordinatorRuntime } from './coordinator-runtime-contract'
import type { AgentTaskRequest, AgentTaskRunner } from './agent-task-contract'
import { parseAgentTaskResult } from './agent-task-contract'
import { registerAgentTaskRunner } from './agent-task-runner-registry'
import {
  MAX_AGENT_TASK_ROUNDS,
  createAgentTaskDispatchState,
  dispatchAgentTasks,
  settleInterruptedAgentTasks
} from './coordinator-agent-tasks'

/** A coordinator agent that delegates once, then finishes on its follow-up; a worker that answers. */
function scriptedAgents(
  requests: AgentTaskRequest[],
  options: { coordinatorAlwaysDelegates?: boolean } = {}
): AgentTaskRunner {
  return async (request) => {
    requests.push(request)
    if (request.agentId === 'agent_hermes') {
      if (!request.continueConversationId || options.coordinatorAlwaysDelegates) {
        const delegate = request.tools!.find((tool) => tool.name === 'orca_delegate')!
        await delegate.invoke({ agent: `agent_agora_${requests.length}`, task: 'find the root cause' })
      }
      return {
        outcome: 'completed',
        conversationId: request.continueConversationId ?? 'conv_hermes',
        turnId: `turn_${requests.length}`,
        text: request.continueConversationId ? 'fixed, using the findings' : 'delegated'
      }
    }
    return { outcome: 'completed', conversationId: 'conv_agora', turnId: 't', text: 'v12 ladder step' }
  }
}

describe('a parent that delegated', () => {
  const databases: OrchestrationDb[] = []

  afterEach(() => {
    registerAgentTaskRunner(null)
    for (const database of databases) {
      database.close()
    }
    databases.length = 0
  })

  function createDb(): OrchestrationDb {
    const database = new OrchestrationDb(':memory:')
    databases.push(database)
    return database
  }

  async function tick(db: OrchestrationDb, runner: AgentTaskRunner, state = createAgentTaskDispatchState()) {
    dispatchAgentTasks({
      db,
      tasks: db.listTasks({ ready: true }),
      slots: 4,
      state,
      onLog: () => {},
      runner
    })
    await Promise.all([...state.inFlight.values()])
  }

  it('waits for its children, then continues its own conversation with their results', async () => {
    const db = createDb()
    const mission = db.createTask({ spec: 'fix the migration', assigneeAgentId: 'agent_hermes' })
    const requests: AgentTaskRequest[] = []
    const runner = scriptedAgents(requests)

    await tick(db, runner)
    const waiting = db.getTask(mission.id)!
    expect(waiting.status).toBe('dispatched')
    expect(parseAgentTaskResult(waiting.result)).toMatchObject({ awaitingChildren: true, round: 1 })
    settleInterruptedAgentTasks(db, () => {})
    expect(db.getTask(mission.id)?.status).toBe('dispatched')

    await tick(db, runner)
    const [child] = db.listTasks().filter((task) => task.parent_id === mission.id)
    expect(child.status).toBe('completed')

    await tick(db, runner)
    const followUp = requests.at(-1)!
    expect(followUp).toMatchObject({ agentId: 'agent_hermes', continueConversationId: 'conv_hermes' })
    expect(followUp.spec).toContain(`Task ${child.id}`)
    expect(followUp.spec).toContain('v12 ladder step')
    const done = db.getTask(mission.id)!
    expect(done.status).toBe('completed')
    expect(parseAgentTaskResult(done.result)).toMatchObject({
      text: 'fixed, using the findings',
      round: 2
    })
  })

  it('stops an agent that keeps delegating instead of finishing', async () => {
    const db = createDb()
    const mission = db.createTask({ spec: 'fix the migration', assigneeAgentId: 'agent_hermes' })
    const runner = scriptedAgents([], { coordinatorAlwaysDelegates: true })

    for (let tickCount = 0; tickCount < MAX_AGENT_TASK_ROUNDS * 2 + 2; tickCount += 1) {
      await tick(db, runner)
    }

    expect(db.getTask(mission.id)?.status).toBe('failed')
    expect(parseAgentTaskResult(db.getTask(mission.id)!.result)).toMatchObject({
      reason: 'agent-rounds-exceeded',
      round: MAX_AGENT_TASK_ROUNDS
    })
  })

  it('does not let a waiting parent hold the only slot its child needs', async () => {
    const db = createDb()
    const mission = db.createTask({ spec: 'fix the migration', assigneeAgentId: 'agent_hermes' })
    registerAgentTaskRunner(scriptedAgents([]))
    const runtime: CoordinatorRuntime = {
      async sendTerminalAgentPrompt() {
        return {}
      },
      async listTerminals() {
        return { terminals: [] }
      },
      async createTerminal() {
        throw new Error('no terminal should be needed')
      },
      async waitForTerminal(handle: string) {
        return { handle, condition: 'exit' }
      },
      async probeWorktreeDrift() {
        return null
      }
    }

    const result = await new Coordinator(db, runtime, {
      spec: 'fix migration',
      coordinatorHandle: 'coord',
      pollIntervalMs: 10,
      maxConcurrent: 1
    }).run()

    expect(result.status).toBe('completed')
    expect(db.getTask(mission.id)?.status).toBe('completed')
  })
})
