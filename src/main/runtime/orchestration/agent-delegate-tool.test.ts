import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'
import { createDelegateTool, DELEGATE_TOOL_NAME } from './agent-delegate-tool'

describe('the orca_delegate tool', () => {
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

  const subject = { projectId: 'github:acme/api', worktreePath: null, revision: 'c'.repeat(40) }

  it('creates a child of the task being worked, requested by the agent that holds it', async () => {
    const db = createDb()
    const holding = db.createTask({ spec: 'fix migration', assigneeAgentId: 'agent_hermes', subject })
    const tool = createDelegateTool(db, holding)

    const result = await tool.invoke({ agent: 'agent_agora', task: 'find the root cause' })

    expect(tool.name).toBe(DELEGATE_TOOL_NAME)
    expect(result.success).toBe(true)
    const [child] = db.listTasks().filter((task) => task.parent_id === holding.id)
    expect(child).toMatchObject({
      assignee_agent_id: 'agent_agora',
      requester_agent_id: 'agent_hermes',
      run_id: holding.run_id,
      spec: 'find the root cause'
    })
    expect(JSON.parse(child.subject!)).toEqual(subject)
    expect(result.text).toContain(child.id)
  })

  it('ignores identity the provider claims in its arguments', async () => {
    const db = createDb()
    const holding = db.createTask({ spec: 'fix migration', assigneeAgentId: 'agent_hermes' })
    const elsewhere = db.createTask({ spec: 'unrelated', assigneeAgentId: 'agent_other' })
    const tool = createDelegateTool(db, holding)

    await tool.invoke({
      agent: 'agent_agora',
      task: 'work',
      requesterAgentId: 'agent_other',
      parentId: elsewhere.id,
      subject: { projectId: 'github:acme/billing' }
    })

    const [child] = db.listTasks().filter((task) => task.assignee_agent_id === 'agent_agora')
    expect(child).toMatchObject({
      parent_id: holding.id,
      requester_agent_id: 'agent_hermes',
      subject: null
    })
  })

  it('refuses incomplete arguments and writes nothing', async () => {
    const db = createDb()
    const holding = db.createTask({ spec: 'fix', assigneeAgentId: 'agent_hermes' })
    const before = db.listTasks().length

    const result = await createDelegateTool(db, holding).invoke({ agent: 'agent_agora' })

    expect(result.success).toBe(false)
    expect(db.listTasks()).toHaveLength(before)
  })

  it('reports a structural refusal to the agent instead of throwing', async () => {
    const db = createDb()
    const holding = db.createTask({ spec: 'fix', assigneeAgentId: 'agent_hermes' })
    const before = db.listTasks().length

    const result = await createDelegateTool(db, holding).invoke({
      agent: 'agent_hermes',
      task: 'do it yourself, again'
    })

    expect(result).toEqual({ success: false, text: 'Delegation refused: delegation-cycle.' })
    expect(db.listTasks()).toHaveLength(before)
  })

  it('cannot delegate from a task no agent holds', async () => {
    const db = createDb()
    const terminalTask = db.createTask({ spec: 'terminal work' })

    const result = await createDelegateTool(db, terminalTask).invoke({ agent: 'agent_a', task: 'x' })

    expect(result.success).toBe(false)
    expect(db.listTasks()).toHaveLength(1)
  })
})
