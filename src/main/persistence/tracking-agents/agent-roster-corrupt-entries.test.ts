import { describe, expect, it, vi } from 'vitest'

import { AgentPersistenceOperations } from './agent-operations'
import type { Agent } from '../../../shared/agent-types'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { StoreOwnedPersistedState } from '../loading-store/store-owned-state'

const valid = (id: string, name: string): Agent => ({
  id,
  name,
  role: '',
  projectId: null,
  createdAt: 1,
  updatedAt: 1
})

function harness(agents: unknown, options: { flushFails?: string } = {}) {
  const state = { agents, projects: [] }
  const flush = vi.fn(async () => {
    if (options.flushFails !== undefined) {
      throw new Error(options.flushFails)
    }
  })
  const operations = new AgentPersistenceOperations({
    state: state as unknown as PersistedState as StoreOwnedPersistedState,
    scheduleSave: vi.fn(),
    flushDurableStateOrThrowAsync: flush,
    now: () => 1_700_000_000_000
  })
  return { operations, state, flush }
}

function thrownBy(read: () => unknown): unknown {
  try {
    read()
  } catch (error) {
    return error
  }
  return undefined
}

describe('the agent roster with corrupt catalog entries', () => {
  it('lists the readable agents, sorted, instead of throwing on a corrupt neighbour', () => {
    // Arrange
    const entries = [
      valid('agent_b', 'Beta'),
      null,
      42,
      'agent',
      ['nested'],
      { id: 'agent_x' },
      { name: 'No id' },
      valid('agent_a', 'Alpha')
    ]
    const { operations } = harness(entries)

    // Act
    const roster = operations.getAgents()

    // Assert
    expect(roster.map((agent) => agent.id)).toEqual(['agent_a', 'agent_b'])
  })

  it('leaves the corrupt entries in the stored catalog untouched', () => {
    // Arrange
    const entries = [valid('agent_a', 'Alpha'), null, { id: 'agent_x' }]
    const snapshot = structuredClone(entries)
    const { operations, state } = harness(entries)

    // Act
    operations.getAgents()

    // Assert
    expect(state.agents).toBe(entries)
    expect(entries).toEqual(snapshot)
  })

  it.each([
    ['an object', { 0: valid('agent_a', 'Alpha') }],
    ['a string', 'agents']
  ])('does not read an unreadable catalog (%s) as an empty roster', (_label, catalog) => {
    // Arrange
    const { operations } = harness(catalog)

    // Act
    const read = (): Agent[] => operations.getAgents()

    // Assert
    expect(read).toThrow()
    expect(thrownBy(read)).toMatchObject({ code: 'agent-catalog-unreadable' })
  })

  it.each([
    ['null', null],
    ['absent', undefined]
  ])('lists nothing when the catalog is %s', (_label, catalog) => {
    // Arrange
    const { operations } = harness(catalog)

    // Act
    const roster = operations.getAgents()

    // Assert
    expect(roster).toEqual([])
  })

  it('creates an agent beside a corrupt entry and keeps that entry in the catalog', async () => {
    // Arrange
    const { operations, state } = harness([null, valid('agent_a', 'Alpha')])

    // Act
    const result = await operations.createAgent({ name: 'Beta', role: '', projectId: null })

    // Assert
    expect(result.outcome).toBe('created')
    expect(state.agents).toHaveLength(3)
    expect((state.agents as unknown[])[0]).toBeNull()
  })

  it('refuses to create an agent as catalog-unreadable when the catalog is not an array, and does not overwrite it', async () => {
    // Arrange
    const catalog = { legacy: true }
    const { operations, state, flush } = harness(catalog)

    // Act
    const result = await operations.createAgent({ name: 'Beta', role: '', projectId: null })

    // Assert
    expect(result).toEqual({ outcome: 'catalog-unreadable' })
    expect(state.agents).toBe(catalog)
    expect(flush).not.toHaveBeenCalled()
  })

  it('rolls a failed write back without throwing on a corrupt entry', async () => {
    // Arrange
    const { operations, state } = harness([null], { flushFails: 'disk full' })

    // Act
    const result = await operations.createAgent({ name: 'Beta', role: '', projectId: null })

    // Assert
    expect(result).toEqual({ outcome: 'not-persisted', reason: 'disk full' })
    expect(state.agents).toEqual([null])
  })
})
