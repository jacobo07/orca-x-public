// Row 31, "Agent identity portability": the same AgentId and history survive a move to another host
// AND a provider change. Two hosts are modelled as two independent stores (own root, own roster,
// own ConversationService) joined only by what a real transfer carries: the Agent JSON and the
// conversation directory bytes. This is a hermetic stand-in, NOT a live two-machine run.
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { AgentTurnEvent } from '../../shared/agent-turn-event'
import { isAgent, mintAgentId } from '../../shared/agent-identity'
import type { Agent } from '../../shared/agent-types'
import type { ConversationProviderEntry } from './conversation-provider-routing'
import { ConversationService } from './conversation-service'
import { ProviderQuotaObservations } from './provider-quota-observations'
import { runRoutedConversationTurn } from './routed-conversation-turn'

function provider(name: 'codex' | 'claude'): ConversationProviderEntry {
  return {
    provider: name,
    tools: 'supported',
    checkAuth: async () => ({ ready: true }),
    driver: {
      provider: name,
      runTurn: async (request) => {
        request.onEvent({ kind: 'turn-started', turnId: request.turnId })
        request.onEvent({
          kind: 'message-completed',
          turnId: request.turnId,
          itemId: `${name}-${request.turnId}`,
          role: 'assistant',
          blocks: [{ type: 'text', text: `answered by ${name}` }]
        })
        request.onEvent({ kind: 'turn-completed', turnId: request.turnId })
        return { providerSessionId: `${name}-session` }
      }
    }
  }
}

describe('one agent across a host move and a provider change', () => {
  let hostA = ''
  let hostB = ''
  let n = 0

  beforeEach(() => {
    hostA = mkdtempSync(join(tmpdir(), 'orca-host-a-'))
    hostB = mkdtempSync(join(tmpdir(), 'orca-host-b-'))
    n = 0
  })
  afterEach(() => {
    rmSync(hostA, { recursive: true, force: true })
    rmSync(hostB, { recursive: true, force: true })
  })

  function deps(service: ConversationService, root: string, p: 'codex' | 'claude') {
    return {
      service,
      providers: [provider(p)],
      quota: new ProviderQuotaObservations(),
      resolveProjectLocation: () => ({ outcome: 'no-project' as const }),
      fallbackCwd: () => root,
      mintTurnId: () => `turn-${++n}`,
      mintItemId: () => `item-${n}`,
      emit: (_id: string, _event: AgentTurnEvent) => {}
    }
  }

  async function texts(service: ConversationService, id: string): Promise<string[]> {
    const loaded = await service.read(id)
    if (loaded.outcome !== 'loaded') throw new Error('not loaded')
    return loaded.record.messages.map((m) =>
      m.blocks.map((b) => (b.type === 'text' ? b.text : '')).join('')
    )
  }

  it('keeps AgentId and history when host A (codex) hands over to host B (claude)', async () => {
    const agent: Agent = { id: mintAgentId(), name: 'Hermes', role: 'reviewer', projectId: null, createdAt: 1, updatedAt: 1 }
    const serviceA = new ConversationService(() => join(hostA, 'conversations'), { readAgents: () => [agent] })
    const created = await serviceA.createForAgent({ agentId: agent.id })
    if (created.outcome !== 'created') throw new Error('not created')
    const id = created.record.id
    await runRoutedConversationTurn(deps(serviceA, hostA, 'codex'), { conversationId: id, text: 'one', cwd: null }, { preferred: 'codex' })

    // The transfer: Agent over the wire as JSON, conversation directory copied byte for byte.
    const wire: unknown = JSON.parse(JSON.stringify(agent))
    if (!isAgent(wire)) throw new Error('agent did not survive the wire')
    cpSync(join(hostA, 'conversations'), join(hostB, 'conversations'), { recursive: true })

    const serviceB = new ConversationService(() => join(hostB, 'conversations'), { readAgents: () => [wire] })
    const second = await runRoutedConversationTurn(deps(serviceB, hostB, 'claude'), { conversationId: id, text: 'two', cwd: null }, { preferred: 'claude' })
    expect(second).toMatchObject({ provider: 'claude', turn: { outcome: 'completed' } })

    const loaded = await serviceB.read(id)
    if (loaded.outcome !== 'loaded') throw new Error('not loaded')
    const binding = serviceB.agentFor(loaded.record)
    expect(binding.kind === 'agent' && binding.agent.id).toBe(agent.id)
    expect(loaded.record.agentId).toBe(agent.id)
    expect(loaded.record.provenance.map((e) => e.agent)).toEqual(['codex', 'claude'])
    expect(await texts(serviceB, id)).toEqual(['one', 'answered by codex', 'two', 'answered by claude'])
    // Host A is untouched by host B's turn.
    expect(await texts(serviceA, id)).toEqual(['one', 'answered by codex'])
  })

  it('goes red for a mutant that re-mints the AgentId on the receiving host', async () => {
    const agent: Agent = { id: mintAgentId(), name: 'Hermes', role: 'reviewer', projectId: null, createdAt: 1, updatedAt: 1 }
    const serviceA = new ConversationService(() => join(hostA, 'conversations'), { readAgents: () => [agent] })
    const created = await serviceA.createForAgent({ agentId: agent.id })
    if (created.outcome !== 'created') throw new Error('not created')
    cpSync(join(hostA, 'conversations'), join(hostB, 'conversations'), { recursive: true })
    const reminted: Agent = { ...agent, id: mintAgentId() }
    const serviceB = new ConversationService(() => join(hostB, 'conversations'), { readAgents: () => [reminted] })
    const loaded = await serviceB.read(created.record.id)
    if (loaded.outcome !== 'loaded') throw new Error('not loaded')
    const binding = serviceB.agentFor(loaded.record)
    expect(binding.kind === 'agent' && binding.agent.id === agent.id).toBe(false)
  })
})
