import { describe, expect, it, vi } from 'vitest'

import { AgentPersistenceOperations } from './agent-operations'
import { isAgentId } from '../../../shared/agent-identity'
import type { Agent } from '../../../shared/agent-types'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { Project } from '../../../shared/project-types'
import type { StoreOwnedPersistedState } from '../loading-store/store-owned-state'

function project(id: string): Project {
  return {
    id,
    displayName: id,
    badgeColor: '#000000',
    sourceRepoIds: [],
    createdAt: 0,
    updatedAt: 0
  }
}

type Harness = {
  operations: AgentPersistenceOperations
  state: { agents: Agent[]; projects: Project[] }
  flush: ReturnType<typeof vi.fn>
  scheduleSave: ReturnType<typeof vi.fn>
}

function harness(options: { projects?: Project[]; flushFails?: string } = {}): Harness {
  const state = { agents: [] as Agent[], projects: options.projects ?? [project('repo:r1')] }
  const scheduleSave = vi.fn()
  const flush = vi.fn(async () => {
    if (options.flushFails !== undefined) {
      throw new Error(options.flushFails)
    }
  })
  const operations = new AgentPersistenceOperations({
    state: state as unknown as PersistedState as StoreOwnedPersistedState,
    scheduleSave,
    flushDurableStateOrThrowAsync: flush,
    now: () => 1_700_000_000_000
  })
  return { operations, state, flush, scheduleSave }
}

describe('createAgent', () => {
  it('mints an Orca agent id rather than deriving one from anything that can change', async () => {
    const { operations, state } = harness()

    const result = await operations.createAgent({
      name: 'Runtime Architect',
      role: 'keeps the daemon honest',
      projectId: 'repo:r1'
    })

    expect(result.outcome).toBe('created')
    if (result.outcome !== 'created') return
    expect(isAgentId(result.agent.id)).toBe(true)
    expect(state.agents).toHaveLength(1)
    expect(state.agents[0]?.id).toBe(result.agent.id)
  })

  it('does not resolve until the roster is on disk', async () => {
    // The whole reason this method is async. `scheduleSave` is debounced 1s/5s, so resolving on the
    // schedule would report success for something a crash in the next five seconds still loses.
    const { operations, flush } = harness()
    let flushed = false
    flush.mockImplementation(async () => {
      await Promise.resolve()
      flushed = true
    })

    const result = await operations.createAgent({ name: 'Ada', role: '', projectId: null })

    expect(flushed).toBe(true)
    expect(result.outcome).toBe('created')
  })

  it('reports a failed write as not-persisted and leaves no agent behind', async () => {
    // Keeping the record in memory after the disk refused it is worse than either outcome alone:
    // the roster would show an agent that is not persisted, and the next unrelated save would
    // quietly commit something nobody was told had failed.
    const { operations, state } = harness({ flushFails: 'disk is full' })

    const result = await operations.createAgent({ name: 'Ada', role: '', projectId: 'repo:r1' })

    expect(result).toEqual({ outcome: 'not-persisted', reason: 'disk is full' })
    expect(state.agents).toEqual([])
  })

  it('rolls back only its own record when a concurrent create is in flight', async () => {
    const { operations, state, flush } = harness({ flushFails: 'disk is full' })
    const bystander: Agent = {
      id: 'agent_bystander',
      name: 'Kept',
      role: '',
      projectId: null,
      createdAt: 0,
      updatedAt: 0
    }
    flush.mockImplementation(async () => {
      state.agents = [...state.agents, bystander]
      throw new Error('disk is full')
    })

    await operations.createAgent({ name: 'Ada', role: '', projectId: null })

    expect(state.agents).toEqual([bystander])
  })

  it('refuses a project that no longer resolves, rather than guessing which one was meant', async () => {
    // The TOCTOU guard. A Project id is DERIVED and getProjectIdentityKey promotes
    // repo: -> git: -> github: mid-session, so the id a form displayed may not exist by the time
    // someone presses the button. Validating here — not when the dialog opened — is the point.
    const { operations, state } = harness({ projects: [project('github:acme/app')] })

    const result = await operations.createAgent({
      name: 'Ada',
      role: '',
      projectId: 'repo:r1'
    })

    expect(result).toEqual({ outcome: 'project-not-found', projectId: 'repo:r1' })
    expect(state.agents).toEqual([])
  })

  it('accepts an agent owned by no project, because that is a real record and not a fallback', async () => {
    const { operations } = harness({ projects: [] })

    const result = await operations.createAgent({ name: 'Ada', role: '', projectId: null })

    expect(result.outcome).toBe('created')
    if (result.outcome !== 'created') return
    expect(result.agent.projectId).toBeNull()
  })

  it('refuses a blank name and writes nothing', async () => {
    const { operations, state, flush } = harness()

    const result = await operations.createAgent({ name: '   ', role: 'x', projectId: null })

    expect(result.outcome).toBe('invalid')
    expect(state.agents).toEqual([])
    // Not merely "no agent": nothing was written at all, so a refusal cannot cost a disk write.
    expect(flush).not.toHaveBeenCalled()
  })

  it('accepts an empty role, so writing a name down is not a form to fill in', async () => {
    const { operations } = harness()

    const result = await operations.createAgent({ name: 'Ada', role: '   ', projectId: null })

    expect(result.outcome).toBe('created')
    if (result.outcome !== 'created') return
    expect(result.agent.role).toBe('')
  })

  it('trims what it stores, so two names that look identical are identical', async () => {
    const { operations } = harness()

    const result = await operations.createAgent({
      name: '  Ada  ',
      role: '  reviews the wire  ',
      projectId: null
    })

    expect(result.outcome).toBe('created')
    if (result.outcome !== 'created') return
    expect(result.agent.name).toBe('Ada')
    expect(result.agent.role).toBe('reviews the wire')
  })

  it('lets two agents share a name, because a name is not identity', async () => {
    const { operations, state } = harness()

    await operations.createAgent({ name: 'Reliability', role: '', projectId: null })
    await operations.createAgent({ name: 'Reliability', role: '', projectId: null })

    expect(state.agents).toHaveLength(2)
    expect(state.agents[0]?.id).not.toBe(state.agents[1]?.id)
  })

  it('appends rather than replacing, so an existing roster survives a create', async () => {
    const { operations, state } = harness()
    await operations.createAgent({ name: 'First', role: '', projectId: null })

    await operations.createAgent({ name: 'Second', role: '', projectId: null })

    expect(state.agents.map((entry) => entry.name)).toEqual(['First', 'Second'])
  })
})
