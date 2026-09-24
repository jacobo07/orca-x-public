import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Agent } from '../../shared/agent-types'
import { ConversationService } from './conversation-service'
import type { ProviderTurnRequest } from './conversation-turn-runner'
import { runAgentTask, type AgentTaskExecutionDeps } from './agent-task-execution'

let root = ''
let agents: Agent[] = []
let service: ConversationService
let driverCalls: ProviderTurnRequest[] = []
let turnCounter = 0

function agent(id: string, projectId: string | null): Agent {
  return { id, name: id, role: `the ${id} role`, projectId, createdAt: 1, updatedAt: 1 } as Agent
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-agent-task-'))
  agents = [agent('agent_free', null), agent('agent_api', 'github:acme/api')]
  service = new ConversationService(() => join(root, 'conversations'), { readAgents: () => agents })
  driverCalls = []
  turnCounter = 0
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function deps(overrides: Partial<AgentTaskExecutionDeps> = {}): AgentTaskExecutionDeps {
  return {
    service,
    readAgents: () => agents,
    resolveProjectLocation: () => ({ outcome: 'no-project' }),
    fallbackCwd: () => root,
    driver: {
      runTurn: async (request) => {
        driverCalls.push(request)
        request.onEvent({ kind: 'turn-started', turnId: request.turnId })
        request.onEvent({
          kind: 'message-completed',
          turnId: request.turnId,
          itemId: 'item-a',
          role: 'assistant',
          blocks: [{ type: 'text', text: 'root cause: the v12 ladder step' }]
        })
        request.onEvent({ kind: 'turn-completed', turnId: request.turnId })
        return { providerSessionId: 'thread-1' }
      }
    },
    checkAuth: async () => ({ ready: true }),
    mintTurnId: () => `turn-${++turnCounter}`,
    mintItemId: () => `user-${turnCounter}`,
    emit: () => {},
    ...overrides
  }
}

describe('runAgentTask', () => {
  it('runs the task as a turn of the assigned agent and returns that turn’s reply', async () => {
    const outcome = await runAgentTask(deps(), {
      taskId: 'task_1',
      agentId: 'agent_free',
      spec: 'Find why the migration fails.',
      subject: null
    })

    expect(outcome).toMatchObject({ outcome: 'completed', text: 'root cause: the v12 ladder step' })
    expect(driverCalls).toHaveLength(1)
    expect(driverCalls[0].text).toContain('Delegated task task_1.')
    expect(driverCalls[0].developerInstructions).toContain('the agent_free role')
    const summaries = await service.list()
    expect(summaries).toHaveLength(1)
  })

  it('states the subject to the agent when it matches the agent’s project', async () => {
    const outcome = await runAgentTask(deps(), {
      taskId: 'task_2',
      agentId: 'agent_api',
      spec: 'Review this change.',
      subject: { projectId: 'github:acme/api', worktreePath: null, revision: 'b'.repeat(40) }
    })

    expect(outcome.outcome).toBe('completed')
    expect(driverCalls[0].text).toContain(`at revision ${'b'.repeat(40)}`)
  })

  it('refuses a subject in another project before any conversation or turn exists', async () => {
    const outcome = await runAgentTask(deps(), {
      taskId: 'task_3',
      agentId: 'agent_api',
      spec: 'Change the billing service.',
      subject: { projectId: 'github:acme/billing', worktreePath: null, revision: null }
    })

    expect(outcome).toMatchObject({ outcome: 'refused', reason: 'subject-project-mismatch' })
    expect(driverCalls).toEqual([])
    expect(await service.list()).toEqual([])
  })

  it('refuses an agent that is not in the roster', async () => {
    const outcome = await runAgentTask(deps(), {
      taskId: 'task_4',
      agentId: 'agent_gone',
      spec: 'anything',
      subject: null
    })

    expect(outcome).toMatchObject({ outcome: 'refused', reason: 'agent-not-found' })
    expect(driverCalls).toEqual([])
  })

  it('reports an unauthenticated provider as a refusal, not as work done', async () => {
    const outcome = await runAgentTask(
      deps({ checkAuth: async () => ({ ready: false, detail: 'codex: no stored credential' }) }),
      { taskId: 'task_5', agentId: 'agent_free', spec: 'anything', subject: null }
    )

    expect(outcome).toMatchObject({ outcome: 'refused', reason: 'auth-required' })
    expect(driverCalls).toEqual([])
  })
})
