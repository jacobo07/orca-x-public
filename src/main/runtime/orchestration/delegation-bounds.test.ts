import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'
import { DelegationRefusedError, MAX_DELEGATION_FAN_OUT } from './delegation-bounds'

describe('delegation bounds at task creation', () => {
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

  function refusalCode(action: () => unknown): string | null {
    try {
      action()
      return null
    } catch (error) {
      if (error instanceof DelegationRefusedError) {
        return error.refusal.code
      }
      throw error
    }
  }

  function taskCount(db: OrchestrationDb): number {
    return db.listTasks().length
  }

  it('refuses A -> B -> A and writes nothing, while A -> B -> C is admitted', () => {
    const db = createDb()
    const root = db.createTask({ spec: 'mission', assigneeAgentId: 'agent_a' })
    const child = db.createTask({
      spec: 'build',
      parentId: root.id,
      assigneeAgentId: 'agent_b',
      requesterAgentId: 'agent_a'
    })
    const before = taskCount(db)

    const cycle = refusalCode(() =>
      db.createTask({
        spec: 'back to a',
        parentId: child.id,
        assigneeAgentId: 'agent_a',
        requesterAgentId: 'agent_b'
      })
    )
    expect(cycle).toBe('delegation-cycle')
    expect(taskCount(db)).toBe(before)

    const onward = db.createTask({
      spec: 'review',
      parentId: child.id,
      assigneeAgentId: 'agent_c',
      requesterAgentId: 'agent_b'
    })
    expect(onward.assignee_agent_id).toBe('agent_c')
  })

  it('refuses an agent delegating under a task it does not hold', () => {
    const db = createDb()
    const root = db.createTask({ spec: 'mission', assigneeAgentId: 'agent_a' })

    expect(
      refusalCode(() =>
        db.createTask({
          spec: 'laundered',
          parentId: root.id,
          assigneeAgentId: 'agent_c',
          requesterAgentId: 'agent_b'
        })
      )
    ).toBe('delegation-requester-not-holder')
  })

  it('refuses an agent creating a root mission; a human root is admitted', () => {
    const db = createDb()

    expect(
      refusalCode(() =>
        db.createTask({ spec: 'self-started', assigneeAgentId: 'agent_b', requesterAgentId: 'agent_a' })
      )
    ).toBe('delegation-requires-parent')
    expect(db.createTask({ spec: 'human root', assigneeAgentId: 'agent_b' }).requester_agent_id).toBeNull()
  })

  it('bounds how many children one task may delegate', () => {
    const db = createDb()
    const root = db.createTask({ spec: 'mission', assigneeAgentId: 'agent_a' })
    for (let index = 0; index < MAX_DELEGATION_FAN_OUT; index += 1) {
      db.createTask({
        spec: `child ${index}`,
        parentId: root.id,
        assigneeAgentId: `agent_child_${index}`,
        requesterAgentId: 'agent_a'
      })
    }

    expect(
      refusalCode(() =>
        db.createTask({
          spec: 'one more',
          parentId: root.id,
          assigneeAgentId: 'agent_extra',
          requesterAgentId: 'agent_a'
        })
      )
    ).toBe('delegation-fan-out-exceeded')
  })

  it('persists the subject the delegation is about', () => {
    const db = createDb()
    const subject = { projectId: 'github:acme/api', worktreePath: '/w/api', revision: 'a'.repeat(40) }

    const task = db.createTask({ spec: 'review', assigneeAgentId: 'agent_r', subject })

    expect(JSON.parse(db.getTask(task.id)!.subject!)).toEqual(subject)
  })
})
