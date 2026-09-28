import { afterEach, describe, expect, it } from 'vitest'
import type { RpcContext } from '../core'
import { createOrchestrationRpcHarness } from './orchestration-rpc-test-harness'
import type { OrchestrationDb } from '../../orchestration/db'
import { MAX_DELEGATION_DEPTH } from '../../orchestration/delegation-bounds'

describe('orchestration.taskCreate delegating to a durable agent', () => {
  const h = createOrchestrationRpcHarness()
  let db: OrchestrationDb
  let ctx: RpcContext

  afterEach(() => {
    h.cleanup()
  })

  async function create(params: Record<string, unknown>): Promise<{ task: { id: string } }> {
    return (await h.call('orchestration.taskCreate', params, ctx)) as { task: { id: string } }
  }

  it('records the assignee agent, and no requester, for a person delegating', async () => {
    ;({ db, ctx } = h.setup(true))

    const { task } = await create({ spec: 'investigate the migration', assigneeAgent: 'agent_b' })

    expect(db.getTask(task.id)).toMatchObject({
      assignee_agent_id: 'agent_b',
      requester_agent_id: null
    })
  })

  it('cannot be told who delegated: a requester in the params is dropped, not trusted', async () => {
    ;({ db, ctx } = h.setup(true))
    const parent = await create({ spec: 'mission', assigneeAgent: 'agent_a' })

    const { task } = await create({
      spec: 'laundered through a claimed identity',
      parent: parent.task.id,
      assigneeAgent: 'agent_c',
      requesterAgentId: 'agent_a',
      requesterAgent: 'agent_a'
    })

    expect(db.getTask(task.id)?.requester_agent_id).toBeNull()
  })

  it('surfaces a structural refusal by its code and writes nothing', async () => {
    ;({ db, ctx } = h.setup(true))
    let parent = (await create({ spec: 'root', assigneeAgent: 'agent_0' })).task.id
    for (let depth = 1; depth <= MAX_DELEGATION_DEPTH; depth += 1) {
      parent = (await create({ spec: `level ${depth}`, parent, assigneeAgent: `agent_${depth}` })).task.id
    }
    const before = db.listTasks().length

    await expect(
      create({ spec: 'too deep', parent, assigneeAgent: 'agent_deep' })
    ).rejects.toThrow(/delegation-depth-exceeded/)
    expect(db.listTasks()).toHaveLength(before)
  })
})
