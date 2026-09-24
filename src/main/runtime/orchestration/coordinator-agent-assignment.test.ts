import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'
import { Coordinator } from './coordinator'
import type { CoordinatorRuntime } from './coordinator-runtime-contract'
import { registerAgentTaskRunner } from './agent-task-runner-registry'
import type { AgentTaskRequest } from './agent-task-contract'

function idleTerminalRuntime(): CoordinatorRuntime & { prompts: string[]; created: number } {
  const runtime = {
    prompts: [] as string[],
    created: 0,
    async sendTerminalAgentPrompt(_handle: string, prompt: string) {
      runtime.prompts.push(prompt)
      return {}
    },
    async listTerminals() {
      return {
        terminals: [{ handle: 'term_idle', worktreeId: 'wt1', connected: true, writable: true }]
      }
    },
    async createTerminal() {
      runtime.created += 1
      return { handle: 'term_new', worktreeId: 'wt1' }
    },
    async waitForTerminal(handle: string) {
      return { handle, condition: 'exit' }
    },
    async probeWorktreeDrift() {
      return null
    }
  }
  return runtime
}

describe('Coordinator with an agent-assigned task', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    registerAgentTaskRunner(null)
    db?.close()
    db = undefined
  })

  it('runs it as the agent’s turn and never hands it to the idle terminal', async () => {
    db = new OrchestrationDb(':memory:')
    const task = db.createTask({ spec: 'investigate the migration', assigneeAgentId: 'agent_b' })
    const requests: AgentTaskRequest[] = []
    registerAgentTaskRunner(async (request) => {
      requests.push(request)
      return { outcome: 'completed', conversationId: 'conv_b', turnId: 'turn_b', text: 'v12 step' }
    })
    const runtime = idleTerminalRuntime()

    const result = await new Coordinator(db, runtime, {
      spec: 'fix migration',
      coordinatorHandle: 'coord',
      pollIntervalMs: 20
    }).run()

    expect(result.status).toBe('completed')
    expect(requests.map((request) => request.agentId)).toEqual(['agent_b'])
    expect(runtime.prompts).toEqual([])
    expect(runtime.created).toBe(0)
    expect(JSON.parse(db.getTask(task.id)!.result!)).toMatchObject({
      outcome: 'completed',
      conversationId: 'conv_b'
    })
  })
})
