import { describe, expect, it } from 'vitest'
import type { Agent } from '../../shared/agent-types'
import { getDefaultPersistedState } from '../../shared/constants'
import type { PersistedState } from '../../shared/persisted-state-types'
import type { Project } from '../../shared/project-types'
import type { Repo } from '../../shared/repo-types'
import { rebuildRepoBackedProjectState } from './profile-project-state-file'

// A durable Agent owns a Project id, and Project ids are DERIVED: `getProjectIdentityKey` promotes
// `repo:` → `git:` → `github:` as a remote probe learns more, mid-session. The succession map is
// computed on each read and thrown away, so an agent that misses the read where its project was
// promoted can never catch up — it just stops belonging to anything the user can see.
//
// Hence these run through `rebuildRepoBackedProjectState`, the one place that already remaps
// projectHostSetups, rather than through a resolver of their own.

const gitIdentity = {
  canonicalKey: 'git.example.com/acme/app',
  remoteName: 'origin',
  remoteUrl: 'git@git.example.com:acme/app.git'
}

const makeRepo = (overrides: Partial<Repo> = {}): Repo => ({
  id: 'r1',
  path: '/repo',
  displayName: 'App',
  badgeColor: '#fff',
  addedAt: 1,
  ...overrides
})

const makeProject = (overrides: Partial<Project> = {}): Project => ({
  id: 'project-1',
  displayName: 'App',
  badgeColor: '#737373',
  sourceRepoIds: [],
  createdAt: 1,
  updatedAt: 1,
  ...overrides
})

const makeAgent = (overrides: Partial<Agent> = {}): Agent => ({
  id: 'agent_fixed-for-assertions',
  name: 'Runtime Architect',
  role: 'reviews runtime and resource decisions',
  projectId: null,
  createdAt: 1,
  updatedAt: 1,
  ...overrides
})

function makeState(overrides: Partial<PersistedState>): PersistedState {
  return { ...getDefaultPersistedState('/home/test'), ...overrides }
}

/** One promotion hop: whatever the repos say now, against the projection stored last time. */
function promote(agents: Agent[], repos: Repo[], storedProjects: Project[]): PersistedState {
  return rebuildRepoBackedProjectState(makeState({ repos, projects: storedProjects, agents }))
}

describe('an agent survives a project identity promotion', () => {
  it('follows repo: → git: when the remote is first resolved', () => {
    const rebuilt = promote(
      [makeAgent({ projectId: 'repo:r1' })],
      [makeRepo({ gitRemoteIdentity: gitIdentity })],
      [makeProject({ id: 'repo:r1', sourceRepoIds: ['r1'] })]
    )

    expect(rebuilt.agents).toHaveLength(1)
    expect(rebuilt.agents[0]?.projectId).toBe('git:git.example.com/acme/app')
    // Identity is the point: the actor did not become a different actor.
    expect(rebuilt.agents[0]?.id).toBe('agent_fixed-for-assertions')
  })

  it('follows the full repo: → git: → github: chain, one hop per read', () => {
    const afterFirst = promote(
      [makeAgent({ projectId: 'repo:r1' })],
      [makeRepo({ gitRemoteIdentity: gitIdentity })],
      [makeProject({ id: 'repo:r1', sourceRepoIds: ['r1'] })]
    )
    expect(afterFirst.agents[0]?.projectId).toBe('git:git.example.com/acme/app')

    // Second read: upstream is now known, so the same repo projects to a github: identity.
    const afterSecond = promote(
      afterFirst.agents,
      [makeRepo({ gitRemoteIdentity: gitIdentity, upstream: { owner: 'acme', repo: 'app' } })],
      [...afterFirst.projects]
    )

    expect(afterSecond.agents).toHaveLength(1)
    expect(afterSecond.agents[0]?.projectId).toBe('github:acme/app')
    expect(afterSecond.agents[0]?.id).toBe('agent_fixed-for-assertions')
  })

  it('leaves an agent that owns no project alone', () => {
    const rebuilt = promote(
      [makeAgent({ projectId: null })],
      [makeRepo({ gitRemoteIdentity: gitIdentity })],
      [makeProject({ id: 'repo:r1', sourceRepoIds: ['r1'] })]
    )

    expect(rebuilt.agents[0]?.projectId).toBeNull()
  })

  // The control that makes the others mean something: a mutation that rewrote EVERY agent's
  // projectId to the surviving id would satisfy all three cases above and quietly move somebody
  // else's actor into this project.
  it('does not touch an agent owned by a project that did not move', () => {
    const rebuilt = promote(
      [
        makeAgent({ id: 'agent_moved', projectId: 'repo:r1' }),
        makeAgent({ id: 'agent_elsewhere', projectId: 'github:other/thing' })
      ],
      [makeRepo({ gitRemoteIdentity: gitIdentity })],
      [makeProject({ id: 'repo:r1', sourceRepoIds: ['r1'] })]
    )

    expect(rebuilt.agents.find((a) => a.id === 'agent_moved')?.projectId).toBe(
      'git:git.example.com/acme/app'
    )
    expect(rebuilt.agents.find((a) => a.id === 'agent_elsewhere')?.projectId).toBe(
      'github:other/thing'
    )
  })

  it('produces no duplicate and no ghost row for the promoted agent', () => {
    const rebuilt = promote(
      [makeAgent({ projectId: 'repo:r1' })],
      [makeRepo({ gitRemoteIdentity: gitIdentity })],
      [makeProject({ id: 'repo:r1', sourceRepoIds: ['r1'] })]
    )

    expect(rebuilt.agents.map((a) => a.id)).toEqual(['agent_fixed-for-assertions'])
    expect(rebuilt.agents.filter((a) => a.projectId === 'repo:r1')).toEqual([])
  })
})
