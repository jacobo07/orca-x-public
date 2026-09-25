// Characterizes the orchestration graph as Agent Federation found it: participants are terminal
// handles, a parent chain has no depth bound, and a decision gate resolves against no subject.
// Each case is inverted IN PLACE by the change that closes it, so the diff is the evidence.
import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'
import { DelegationRefusedError, MAX_DELEGATION_DEPTH } from './delegation-bounds'

describe('delegation authority, as found', () => {
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

  it('records the durable agent a task is delegated to and by, beside the terminal incarnation', () => {
    const db = createDb()
    const mission = db.createTask({ spec: 'fix migration', assigneeAgentId: 'agent_coord' })

    const task = db.createTask({
      spec: 'investigate',
      parentId: mission.id,
      createdByTerminalHandle: 'term_abc',
      assigneeAgentId: 'agent_builder',
      requesterAgentId: 'agent_coord'
    })

    expect(task.created_by_terminal_handle).toBe('term_abc')
    expect(task).toMatchObject({
      assignee_agent_id: 'agent_builder',
      requester_agent_id: 'agent_coord'
    })
  })

  it('bounds an agent delegation chain, while a terminal-created chain keeps its historical shape', () => {
    const db = createDb()
    let terminalParent: string | undefined
    for (let depth = 0; depth < 24; depth += 1) {
      terminalParent = db.createTask({ spec: `level ${depth}`, parentId: terminalParent }).id
    }
    expect(db.getTask(terminalParent!)?.parent_id).not.toBeNull()

    let parentId = db.createTask({ spec: 'root', assigneeAgentId: 'agent_0' }).id
    for (let depth = 1; depth <= MAX_DELEGATION_DEPTH; depth += 1) {
      parentId = db.createTask({
        spec: `level ${depth}`,
        parentId,
        assigneeAgentId: `agent_${depth}`,
        requesterAgentId: `agent_${depth - 1}`
      }).id
    }
    const beyond = (): unknown =>
      db.createTask({
        spec: 'one too deep',
        parentId,
        assigneeAgentId: 'agent_x',
        requesterAgentId: `agent_${MAX_DELEGATION_DEPTH}`
      })

    expect(beyond).toThrow(DelegationRefusedError)
    expect(beyond).toThrow(/delegation-depth-exceeded/)
  })

  // Inverted by P5: a gate can name the exact commit it approves, and then free text cannot decide it.
  it('binds a decision gate to a commit, which free-text resolution can no longer approve', () => {
    const db = createDb()
    const task = db.createTask({ spec: 'change the migration' })
    const gate = db.createGate({
      taskId: task.id,
      question: 'Ship this patch?',
      subject: { projectId: 'p', worktreePath: '/w', revision: 'a'.repeat(40), patchHash: 'h' }
    })

    expect(JSON.parse(gate.subject!)).toMatchObject({ revision: 'a'.repeat(40), patchHash: 'h' })
    expect(() => db.resolveGate(gate.id, 'approved')).toThrow(/decide it in Orca/)
    expect(db.getGate(gate.id)?.status).toBe('pending')
    expect(db.getTask(task.id)?.status).toBe('blocked')
    // A gate that names no commit keeps its free-text shape.
    const loose = db.createGate({ taskId: db.createTask({ spec: 'other' }).id, question: 'Proceed?' })
    expect(db.resolveGate(loose.id, 'approved')?.status).toBe('resolved')
  })
})
