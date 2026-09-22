import { describe, expect, it, vi } from 'vitest'

import { createAgentIpcHandlers } from './agents'
import { AgentPersistenceOperations } from '../persistence/tracking-agents/agent-operations'
import { mintAgentId } from '../../shared/agent-identity'
import type { Agent } from '../../shared/agent-types'
import type { PersistedState } from '../../shared/persisted-state-types'
import type { StoreOwnedPersistedState } from '../persistence/loading-store/store-owned-state'

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: mintAgentId(),
    name: 'Runtime Architect',
    role: 'keeps the daemon honest',
    projectId: 'repo:r1',
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

function stateHolding(agents: Agent[]): StoreOwnedPersistedState {
  return { agents } as unknown as PersistedState as StoreOwnedPersistedState
}

describe('AgentPersistenceOperations.getAgents', () => {
  it('orders by display name so the roster reads like a list of people', () => {
    const operations = new AgentPersistenceOperations({
      state: stateHolding([agent({ name: 'Zoe' }), agent({ name: 'Ada' }), agent({ name: 'Mo' })])
    })

    expect(operations.getAgents().map((entry) => entry.name)).toEqual(['Ada', 'Mo', 'Zoe'])
  })

  it('keeps two agents that share a name in a stable order', () => {
    // A name is not identity, so duplicates are legal. Without the id tie-break their relative
    // order is whatever the sort happens to do, and a roster that reshuffles between reads looks
    // like it changed when nothing did.
    const first = agent({ id: 'agent_aaa', name: 'Reliability' })
    const second = agent({ id: 'agent_bbb', name: 'Reliability' })
    const forward = new AgentPersistenceOperations({ state: stateHolding([first, second]) })
    const reversed = new AgentPersistenceOperations({ state: stateHolding([second, first]) })

    expect(forward.getAgents().map((entry) => entry.id)).toEqual(['agent_aaa', 'agent_bbb'])
    expect(reversed.getAgents().map((entry) => entry.id)).toEqual(['agent_aaa', 'agent_bbb'])
  })

  it('does not hand out the array the store is holding', () => {
    // A caller that sorted or spliced the returned value would be mutating PersistedState.
    const stored = [agent({ name: 'Ada' })]
    const operations = new AgentPersistenceOperations({ state: stateHolding(stored) })

    operations.getAgents().push(agent({ name: 'Intruder' }))

    expect(stored).toHaveLength(1)
  })

  it('reads an absent roster as empty rather than throwing', () => {
    // A profile written before agents existed has no key at all, and a durable reader that dies on
    // older data is a reader that cannot be deployed.
    const operations = new AgentPersistenceOperations({
      state: {} as unknown as StoreOwnedPersistedState
    })

    expect(operations.getAgents()).toEqual([])
  })
})

describe('agents:list', () => {
  it('answers with what the store holds now, not with a snapshot taken at registration', async () => {
    // The whole reason the handler takes a reader instead of an array: `agents[].projectId` is
    // rewritten by rebuildRepoBackedProjectState when a Project id is promoted, and a roster
    // captured once would keep answering with the pre-promotion owner forever.
    let roster: Agent[] = [agent({ name: 'Ada', projectId: 'repo:r1' })]
    const handlers = createAgentIpcHandlers({ readAgents: () => roster })

    expect((await handlers['agents:list']())[0]?.projectId).toBe('repo:r1')

    roster = [agent({ name: 'Ada', projectId: 'github:acme/app' })]

    expect((await handlers['agents:list']())[0]?.projectId).toBe('github:acme/app')
  })

  it('reads on every call, so a profile switch is not served the previous roster', async () => {
    const readAgents = vi.fn(() => [] as Agent[])
    const handlers = createAgentIpcHandlers({ readAgents })

    await handlers['agents:list']()
    await handlers['agents:list']()

    expect(readAgents).toHaveBeenCalledTimes(2)
  })

  it('rejects rather than throwing synchronously when the reader fails', async () => {
    // The declared type is a Promise, so a caller may reasonably use .catch() instead of try/catch.
    const handlers = createAgentIpcHandlers({
      readAgents: () => {
        throw new Error('profile is not loaded')
      }
    })

    await expect(handlers['agents:list']()).rejects.toThrow('profile is not loaded')
  })
})
