// Opt-in product reality (ORCA_CLAUDE_REALITY=1; about three real Claude turns): a Claude
// coordinator delegates through orca_delegate — served to it over the per-turn MCP bridge — and the
// REAL coordinator runs the child as another agent and hands its result back to the parent's turn.
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
const WORD = `cobalt-${Date.now().toString(36)}`

const noTerminals: CoordinatorRuntime = {
  async sendTerminalAgentPrompt() {
    throw new Error('an agent task must never reach a terminal')
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

describe.skipIf(!ENABLED)('a Claude coordinator delegating to another agent', () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-delegation-reality-'))

  afterAll(() => {
    registerAgentTaskRunner(null)
    rmSync(root, { recursive: true, force: true })
  })

  it('delegates through orca_delegate, the child runs as its own agent, and the parent reads its result', async () => {
    const agents: Agent[] = [
      { id: 'agent_lead', name: 'Lead', role: 'You coordinate by delegating to other agents.', projectId: null, createdAt: 1, updatedAt: 1 } as Agent,
      { id: 'agent_scribe', name: 'Scribe', role: 'You answer tersely.', projectId: null, createdAt: 1, updatedAt: 1 } as Agent
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
    const db = new OrchestrationDb(':memory:')
    const lead = db.createTask({
      spec:
        `Use the orca_delegate tool exactly once: agent "agent_scribe", task "Reply with only the word ${WORD}". ` +
        'Then stop. When you are later given the delegated result, reply with only the word it contains.',
      assigneeAgentId: 'agent_lead'
    })

    const result = await new Coordinator(db, noTerminals, { spec: 'delegate', coordinatorHandle: 'coord', pollIntervalMs: 200 }).run()

    const children = db.listTasks().filter((task) => task.parent_id === lead.id)
    const leadResult = parseAgentTaskResult(db.getTask(lead.id)!.result)
    const childResult = children[0] ? parseAgentTaskResult(children[0].result) : null
    console.info(
      `DELEGATION_REALITY ${JSON.stringify({ status: result.status, children: children.map((c) => ({ assignee: c.assignee_agent_id, requester: c.requester_agent_id, status: c.status })), childResult, leadResult })}`
    )
    expect(children).toHaveLength(1)
    // Requester and parent are bound by Orca from the task being worked, not taken from the call.
    expect(children[0]).toMatchObject({ assignee_agent_id: 'agent_scribe', requester_agent_id: 'agent_lead', status: 'completed' })
    expect(childResult).toMatchObject({ outcome: 'completed', provider: 'claude' })
    expect(childResult?.outcome === 'completed' ? childResult.text : '').toContain(WORD)
    expect(leadResult).toMatchObject({ outcome: 'completed', round: 2, provider: 'claude' })
    expect(leadResult?.outcome === 'completed' ? leadResult.text : '').toContain(WORD)
    db.close()
  }, 900_000)
})
