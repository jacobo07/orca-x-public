import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { AgentTurnEvent } from '../../shared/agent-turn-event'
import { mintAgentId } from '../../shared/agent-identity'
import type { Agent } from '../../shared/agent-types'
import type { ConversationRecord } from '../../shared/conversation-types'
import type { ConversationProviderEntry } from './conversation-provider-routing'
import { ConversationService } from './conversation-service'
import type { ProviderTurnRequest } from './conversation-turn-runner'
import { ProviderQuotaObservations } from './provider-quota-observations'
import { runRoutedConversationTurn } from './routed-conversation-turn'

function fakeProvider(
  provider: 'codex' | 'claude',
  calls: ProviderTurnRequest[]
): ConversationProviderEntry {
  return {
    provider,
    tools: 'supported',
    checkAuth: async () => ({ ready: true }),
    driver: {
      provider,
      runTurn: async (request) => {
        calls.push(request)
        request.onEvent({ kind: 'turn-started', turnId: request.turnId })
        request.onEvent({
          kind: 'message-completed',
          turnId: request.turnId,
          itemId: `${provider}-item-${calls.length}`,
          role: 'assistant',
          blocks: [{ type: 'text', text: `answered by ${provider}` }]
        })
        request.onEvent({ kind: 'turn-completed', turnId: request.turnId })
        return { providerSessionId: `${provider}-session` }
      }
    }
  }
}

function text(record: ConversationRecord): string[] {
  return record.messages.map((message) =>
    message.blocks.map((block) => (block.type === 'text' ? block.text : '')).join('')
  )
}

/** What "the same agent, coherent conversation" means across a provider change. Empty = coherent. */
function coherenceViolations(
  service: ConversationService,
  agent: Agent,
  record: ConversationRecord,
  expectedTexts: string[]
): string[] {
  const violations: string[] = []
  const binding = service.agentFor(record)
  if (binding.kind !== 'agent' || binding.agent.id !== agent.id) {
    violations.push('conversation is no longer bound to the original AgentId')
  }
  if (record.agentId !== agent.id) {
    violations.push('record.agentId changed')
  }
  if (JSON.stringify(text(record)) !== JSON.stringify(expectedTexts)) {
    violations.push('history is not the continuous turn sequence')
  }
  return violations
}

describe('one agent across a provider change', () => {
  let root = ''
  let agent: Agent
  let service: ConversationService
  let emitted: AgentTurnEvent[] = []
  const codexCalls: ProviderTurnRequest[] = []
  const claudeCalls: ProviderTurnRequest[] = []

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orca-agent-switch-'))
    agent = { id: mintAgentId(), name: 'Hermes', role: 'reviewer', projectId: null, createdAt: 1, updatedAt: 1 }
    service = new ConversationService(() => join(root, 'conversations'), { readAgents: () => [agent] })
    emitted = []
    turn = 0
    codexCalls.length = 0
    claudeCalls.length = 0
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  let turn = 0
  function deps(service_: ConversationService) {
    return {
      service: service_,
      providers: [fakeProvider('codex', codexCalls), fakeProvider('claude', claudeCalls)],
      quota: new ProviderQuotaObservations(),
      resolveProjectLocation: () => ({ outcome: 'no-project' as const }),
      fallbackCwd: () => root,
      mintTurnId: () => `turn-${++turn}`,
      mintItemId: () => `item-${turn}`,
      emit: (_id: string, event: AgentTurnEvent) => {
        emitted.push(event)
      }
    }
  }

  async function twoTurns(svc: ConversationService, id: string) {
    const first = await runRoutedConversationTurn(
      deps(svc),
      { conversationId: id, text: 'one', cwd: null },
      { preferred: 'codex' }
    )
    const second = await runRoutedConversationTurn(
      deps(svc),
      { conversationId: id, text: 'two', cwd: null },
      { preferred: 'claude' }
    )
    return { first, second }
  }

  const EXPECTED = ['one', 'answered by codex', 'two', 'answered by claude']

  it('keeps AgentId and history across a codex turn then a claude turn, each with its routing reason', async () => {
    const created = await service.createForAgent({ agentId: agent.id })
    if (created.outcome !== 'created') throw new Error('agent conversation not created')

    const { first, second } = await twoTurns(service, created.record.id)

    expect(first).toMatchObject({ provider: 'codex', turn: { outcome: 'completed' }, route: 'running on codex' })
    expect(second).toMatchObject({ provider: 'claude', turn: { outcome: 'completed' }, route: 'running on claude' })
    expect(codexCalls).toHaveLength(1)
    expect(claudeCalls).toHaveLength(1)
    expect(claudeCalls[0].resumeSessionId).toBeNull()
    const routed = emitted.filter((event) => event.kind === 'provider-status')
    expect(routed.map((event) => (event.kind === 'provider-status' ? event.detail : ''))).toEqual([
      'running on codex',
      'running on claude'
    ])
    const loaded = await service.read(created.record.id)
    if (loaded.outcome !== 'loaded') throw new Error('not loaded')
    expect(loaded.record.provenance.map((entry) => entry.agent)).toEqual(['codex', 'claude'])
    expect(coherenceViolations(service, agent, loaded.record, EXPECTED)).toEqual([])
  })

  it('goes red for a mutant that mints a new AgentId when the provider changes', async () => {
    const created = await service.createForAgent({ agentId: agent.id })
    if (created.outcome !== 'created') throw new Error('agent conversation not created')
    await twoTurns(service, created.record.id)
    const loaded = await service.read(created.record.id)
    if (loaded.outcome !== 'loaded') throw new Error('not loaded')

    // Mutant: on provider change the roster's agent is replaced by one with a freshly minted id.
    const reminted: Agent = { ...agent, id: mintAgentId() }
    const mutantService = new ConversationService(() => join(root, 'conversations'), {
      readAgents: () => [reminted]
    })

    expect(coherenceViolations(mutantService, agent, loaded.record, EXPECTED)).toContain(
      'conversation is no longer bound to the original AgentId'
    )
    expect(coherenceViolations(service, agent, loaded.record, EXPECTED)).toEqual([])
  })
})
