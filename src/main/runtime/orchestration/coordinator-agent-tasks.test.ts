import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'
import type { AgentTaskOutcome, AgentTaskRequest, AgentTaskRunner } from './agent-task-contract'
import {
  createAgentTaskDispatchState,
  dispatchAgentTasks,
  settleInterruptedAgentTasks
} from './coordinator-agent-tasks'

describe('agent-assigned task dispatch', () => {
  const databases: OrchestrationDb[] = []

  afterEach(() => {
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

  function recordingRunner(outcome: AgentTaskOutcome): {
    runner: AgentTaskRunner
    calls: AgentTaskRequest[]
  } {
    const calls: AgentTaskRequest[] = []
    return {
      calls,
      runner: async (request) => {
        calls.push(request)
        return outcome
      }
    }
  }

  async function settle(state: ReturnType<typeof createAgentTaskDispatchState>): Promise<void> {
    await Promise.all([...state.inFlight.values()])
  }

  it('settles the task with a structured result and promotes its dependent', async () => {
    const db = createDb()
    const task = db.createTask({ spec: 'investigate', assigneeAgentId: 'agent_b' })
    const dependent = db.createTask({ spec: 'report', deps: [task.id] })
    const state = createAgentTaskDispatchState()
    const { runner, calls } = recordingRunner({
      outcome: 'completed',
      conversationId: 'conv_1',
      turnId: 'turn_1',
      text: 'found it'
    })

    const used = dispatchAgentTasks({ db, tasks: [task], slots: 4, state, onLog: () => {}, runner })
    expect(used).toBe(1)
    expect(db.getTask(task.id)?.status).toBe('dispatched')
    await settle(state)

    expect(calls).toEqual([
      expect.objectContaining({ taskId: task.id, agentId: 'agent_b', spec: 'investigate', subject: null })
    ])
    expect(calls[0].tools?.map((tool) => tool.name)).toEqual(['orca_delegate'])
    const settled = db.getTask(task.id)!
    expect(settled.status).toBe('completed')
    expect(JSON.parse(settled.result!)).toEqual({
      schema: 'orca.agent-task-result/1',
      round: 1,
      outcome: 'completed',
      conversationId: 'conv_1',
      turnId: 'turn_1',
      text: 'found it'
    })
    expect(db.getTask(dependent.id)?.status).toBe('ready')
  })

  it('leaves the task ready, and says so once, when this host has no agent runner', () => {
    const db = createDb()
    const task = db.createTask({ spec: 'investigate', assigneeAgentId: 'agent_b' })
    const state = createAgentTaskDispatchState()
    const logs: string[] = []

    for (let tick = 0; tick < 3; tick += 1) {
      expect(
        dispatchAgentTasks({ db, tasks: [task], slots: 4, state, onLog: (m) => logs.push(m), runner: null })
      ).toBe(0)
    }

    expect(db.getTask(task.id)?.status).toBe('ready')
    expect(logs.filter((line) => line.includes(task.id))).toHaveLength(1)
  })

  it('settles a task whose runner threw, rather than leaving it dispatched', async () => {
    const db = createDb()
    const task = db.createTask({ spec: 'investigate', assigneeAgentId: 'agent_b' })
    const state = createAgentTaskDispatchState()

    dispatchAgentTasks({
      db,
      tasks: [task],
      slots: 4,
      state,
      onLog: () => {},
      runner: async () => {
        throw new Error('driver exploded')
      }
    })
    await settle(state)

    const settled = db.getTask(task.id)!
    expect(settled.status).toBe('failed')
    expect(JSON.parse(settled.result!)).toMatchObject({ outcome: 'failed', reason: 'driver exploded' })
  })

  it('refuses a task whose subject cannot be read, without running the agent', () => {
    const db = createDb()
    const task = db.createTask({ spec: 'review', assigneeAgentId: 'agent_b' })
    const damaged = { ...task, subject: '{not json' }
    const state = createAgentTaskDispatchState()
    const { runner, calls } = recordingRunner({ outcome: 'refused', reason: 'x', detail: 'x' })

    dispatchAgentTasks({ db, tasks: [damaged], slots: 4, state, onLog: () => {}, runner })

    expect(calls).toEqual([])
    expect(JSON.parse(db.getTask(task.id)!.result!)).toMatchObject({ reason: 'subject-unreadable' })
  })

  it('settles only agent tasks with no live turn as interrupted', async () => {
    const db = createDb()
    const orphan = db.createTask({ spec: 'orphan', assigneeAgentId: 'agent_b' })
    db.updateTaskStatus(orphan.id, 'dispatched')
    const terminalTask = db.createTask({ spec: 'terminal work' })
    db.updateTaskStatus(terminalTask.id, 'dispatched')
    const live = db.createTask({ spec: 'live', assigneeAgentId: 'agent_c' })
    const state = createAgentTaskDispatchState()
    let release: (outcome: AgentTaskOutcome) => void = () => {}
    dispatchAgentTasks({
      db,
      tasks: [live],
      slots: 4,
      state,
      onLog: () => {},
      runner: () => new Promise((resolve) => (release = resolve))
    })

    settleInterruptedAgentTasks(db, () => {})

    expect(JSON.parse(db.getTask(orphan.id)!.result!)).toMatchObject({ reason: 'interrupted' })
    expect(db.getTask(terminalTask.id)?.status).toBe('dispatched')
    expect(db.getTask(live.id)?.status).toBe('dispatched')
    release({ outcome: 'completed', conversationId: 'c', turnId: 't', text: 'done' })
    await settle(state)
    expect(db.getTask(live.id)?.status).toBe('completed')
  })
})
