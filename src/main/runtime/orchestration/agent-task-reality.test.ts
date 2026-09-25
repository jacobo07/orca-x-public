// Opt-in product reality (ORCA_CLAUDE_REALITY=1; spends real quota): a person assigns a task to a
// durable agent, and the REAL coordinator runs it through the SAME provider routing production
// composes. Nothing is faked below the coordinator's runtime (which offers no terminals at all).
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import type { Agent } from '../../../shared/agent-types'
import { runAgentTask } from '../../conversation/agent-task-execution'
import { ConversationService } from '../../conversation/conversation-service'
import { composeProviderRouting } from '../../conversation/provider-routing-composition'
import { parseAgentTaskResult } from './agent-task-contract'
import { registerAgentTaskRunner } from './agent-task-runner-registry'
import { Coordinator } from './coordinator'
import type { CoordinatorRuntime } from './coordinator-runtime-contract'
import { OrchestrationDb } from './db'

const ENABLED = process.env.ORCA_CLAUDE_REALITY === '1'
const WORD = `quartz-${Date.now().toString(36)}`

describe.skipIf(!ENABLED)('a delegated agent task against a real provider', () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-agent-task-reality-'))

  afterAll(() => {
    registerAgentTaskRunner(null)
    rmSync(root, { recursive: true, force: true })
  })

  it('runs as the agent’s turn on a routed provider and settles with a structured result', async () => {
    const agents: Agent[] = [
      { id: 'agent_reviewer', name: 'Reviewer', role: 'You answer tersely.', projectId: null, createdAt: 1, updatedAt: 1 } as Agent
    ]
    const service = new ConversationService(() => join(root, 'conversations'), { readAgents: () => agents })
    let counter = 0
    const base = {
      service,
      resolveProjectLocation: () => ({ outcome: 'no-project' as const }),
      fallbackCwd: () => root,
      mintTurnId: () => `turn-${++counter}`,
      mintItemId: () => `item-${counter}`,
      emit: () => {}
    }
    const routing = composeProviderRouting({ base })
    registerAgentTaskRunner((request) =>
      runAgentTask(
        {
          ...base,
          driver: routing.providers[0].driver,
          checkAuth: routing.providers[0].checkAuth,
          readAgents: () => agents,
          runRoutedTurn: (turn, requirement) => routing.runTurn(turn, { prefersTools: true, ...requirement })
        },
        request
      )
    )
    const prompts: string[] = []
    const runtime: CoordinatorRuntime = {
      async sendTerminalAgentPrompt(_handle, prompt) {
        prompts.push(prompt)
        return {}
      },
      async listTerminals() {
        return { terminals: [] }
      },
      async createTerminal() {
        throw new Error('an agent task must never need a terminal')
      },
      async waitForTerminal(handle) {
        return { handle, condition: 'exit' }
      },
      async probeWorktreeDrift() {
        return null
      }
    }
    const db = new OrchestrationDb(':memory:')
    const task = db.createTask({ spec: `Reply with exactly this word and nothing else: ${WORD}`, assigneeAgentId: 'agent_reviewer' })

    const result = await new Coordinator(db, runtime, { spec: 'reality', coordinatorHandle: 'coord', pollIntervalMs: 200 }).run()

    expect(result.status).toBe('completed')
    expect(prompts).toEqual([])
    const settled = parseAgentTaskResult(db.getTask(task.id)!.result)
    expect(settled).toMatchObject({ outcome: 'completed', round: 1 })
    expect(settled?.outcome === 'completed' ? settled.text : '').toContain(WORD)
    const conversation = await service.read(settled?.outcome === 'completed' ? settled.conversationId : '')
    expect(conversation.outcome).toBe('loaded')
    if (conversation.outcome === 'loaded') {
      expect(conversation.record.agentId).toBe('agent_reviewer')
      // Registry order puts Codex first; it runs the task only when it can authenticate here.
      const expected = (await routing.providers[0].checkAuth()).ready ? 'codex' : 'claude'
      expect(conversation.record.provenance.at(-1)?.agent).toBe(expected)
    }
    db.close()
  }, 240_000)
})
