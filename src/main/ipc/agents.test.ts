import { describe, expect, it, vi } from 'vitest'

import { createAgentIpcHandlers } from './agents'
import { AgentPersistenceOperations } from '../persistence/tracking-agents/agent-operations'
import { mintAgentId } from '../../shared/agent-identity'
import type { Agent, AgentCreationResult } from '../../shared/agent-types'
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

/** Read-path only: creation has its own file, and these cases must not depend on a writer. */
function readerOver(agents: Agent[] | undefined): AgentPersistenceOperations {
  return new AgentPersistenceOperations({
    state: { agents } as unknown as PersistedState as StoreOwnedPersistedState,
    scheduleSave: () => {
      throw new Error('the read path must not schedule a save')
    },
    flushDurableStateOrThrowAsync: async () => {
      throw new Error('the read path must not flush')
    }
  })
}

const refuseCreate = async (): Promise<AgentCreationResult> => ({
  outcome: 'invalid',
  reason: 'not under test'
})

describe('AgentPersistenceOperations.getAgents', () => {
  it('orders by display name so the roster reads like a list of people', () => {
    const operations = readerOver([
      agent({ name: 'Zoe' }),
      agent({ name: 'Ada' }),
      agent({ name: 'Mo' })
    ])

    expect(operations.getAgents().map((entry) => entry.name)).toEqual(['Ada', 'Mo', 'Zoe'])
  })

  it('keeps two agents that share a name in a stable order', () => {
    // A name is not identity, so duplicates are legal. Without the id tie-break their relative
    // order is whatever the sort happens to do, and a roster that reshuffles between reads looks
    // like it changed when nothing did.
    const first = agent({ id: 'agent_aaa', name: 'Reliability' })
    const second = agent({ id: 'agent_bbb', name: 'Reliability' })

    expect(readerOver([first, second]).getAgents().map((entry) => entry.id)).toEqual([
      'agent_aaa',
      'agent_bbb'
    ])
    expect(readerOver([second, first]).getAgents().map((entry) => entry.id)).toEqual([
      'agent_aaa',
      'agent_bbb'
    ])
  })

  it('does not hand out the array the store is holding', () => {
    // A caller that sorted or spliced the returned value would be mutating PersistedState.
    const stored = [agent({ name: 'Ada' })]

    readerOver(stored).getAgents().push(agent({ name: 'Intruder' }))

    expect(stored).toHaveLength(1)
  })

  it('reads an absent roster as empty rather than throwing', () => {
    // A profile written before agents existed has no key at all, and a durable reader that dies on
    // older data is a reader that cannot be deployed.
    expect(readerOver(undefined).getAgents()).toEqual([])
  })
})

describe('agents:list', () => {
  it('answers with what the store holds now, not with a snapshot taken at registration', async () => {
    // The whole reason the handler takes a reader instead of an array: `agents[].projectId` is
    // rewritten by rebuildRepoBackedProjectState when a Project id is promoted, and a roster
    // captured once would keep answering with the pre-promotion owner forever.
    let roster: Agent[] = [agent({ name: 'Ada', projectId: 'repo:r1' })]
    const handlers = createAgentIpcHandlers({
      readAgents: () => roster,
      createAgent: refuseCreate
    })

    expect((await handlers['agents:list']())[0]?.projectId).toBe('repo:r1')

    roster = [agent({ name: 'Ada', projectId: 'github:acme/app' })]

    expect((await handlers['agents:list']())[0]?.projectId).toBe('github:acme/app')
  })

  it('reads on every call, so a profile switch is not served the previous roster', async () => {
    const readAgents = vi.fn(() => [] as Agent[])
    const handlers = createAgentIpcHandlers({ readAgents, createAgent: refuseCreate })

    await handlers['agents:list']()
    await handlers['agents:list']()

    expect(readAgents).toHaveBeenCalledTimes(2)
  })

  it('rejects rather than throwing synchronously when the reader fails', async () => {
    // The declared type is a Promise, so a caller may reasonably use .catch() instead of try/catch.
    const handlers = createAgentIpcHandlers({
      readAgents: () => {
        throw new Error('profile is not loaded')
      },
      createAgent: refuseCreate
    })

    await expect(handlers['agents:list']()).rejects.toThrow('profile is not loaded')
  })
})

describe('agents:create', () => {
  it('passes the request through to the owner unchanged', async () => {
    const createAgent = vi.fn(refuseCreate)
    const handlers = createAgentIpcHandlers({ readAgents: () => [], createAgent })

    await handlers['agents:create']({ name: 'Ada', role: 'reviews', projectId: 'repo:r1' })

    expect(createAgent).toHaveBeenCalledWith({
      name: 'Ada',
      role: 'reviews',
      projectId: 'repo:r1'
    })
  })

  it('carries a null project through, because that is a real record and not an absence', async () => {
    const createAgent = vi.fn(refuseCreate)
    const handlers = createAgentIpcHandlers({ readAgents: () => [], createAgent })

    await handlers['agents:create']({ name: 'Ada', role: '', projectId: null })

    expect(createAgent).toHaveBeenCalledWith({ name: 'Ada', role: '', projectId: null })
  })

  it('REFUSES a missing project binding instead of defaulting it to null', async () => {
    // The trap this exists for: null is a legitimate value here, so silently defaulting an absent
    // field would turn a renderer that dropped the binding into a global agent, and the person who
    // picked a project would never learn their choice was lost.
    const createAgent = vi.fn(refuseCreate)
    const handlers = createAgentIpcHandlers({ readAgents: () => [], createAgent })

    await expect(handlers['agents:create']({ name: 'Ada', role: '' })).rejects.toThrow(
      'explicit project id or null'
    )
    expect(createAgent).not.toHaveBeenCalled()
  })

  it('refuses a malformed payload rather than reporting our own bug as their refusal', async () => {
    const createAgent = vi.fn(refuseCreate)
    const handlers = createAgentIpcHandlers({ readAgents: () => [], createAgent })

    await expect(
      handlers['agents:create']({ name: 42, role: '', projectId: null })
    ).rejects.toThrow('name must be a string')
    expect(createAgent).not.toHaveBeenCalled()
  })

  it('returns the owner’s refusal as an outcome, not as an exception', async () => {
    const handlers = createAgentIpcHandlers({
      readAgents: () => [],
      createAgent: async () => ({ outcome: 'project-not-found', projectId: 'repo:gone' })
    })

    await expect(
      handlers['agents:create']({ name: 'Ada', role: '', projectId: 'repo:gone' })
    ).resolves.toEqual({ outcome: 'project-not-found', projectId: 'repo:gone' })
  })
})
