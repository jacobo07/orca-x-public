import { describe, expect, it } from 'vitest'

import { groupAgentsByProject } from './agent-project-grouping'
import type { Agent } from '../../../../shared/agent-types'
import type { Project } from '../../../../shared/project-types'

function project(id: string, displayName = id): Project {
  return {
    id,
    displayName,
    badgeColor: '#000000',
    sourceRepoIds: [],
    createdAt: 0,
    updatedAt: 0
  }
}

function agent(id: string, projectId: string | null, name = id): Agent {
  return { id, name, role: '', projectId, createdAt: 0, updatedAt: 0 }
}

describe('groupAgentsByProject', () => {
  it('puts each agent under the project that owns it', () => {
    const groups = groupAgentsByProject(
      [agent('agent_a', 'p1'), agent('agent_b', 'p2'), agent('agent_c', 'p1')],
      [project('p1'), project('p2')]
    )

    expect(groups).toHaveLength(2)
    expect(groups[0]).toMatchObject({ kind: 'project' })
    expect(groups[0]?.agents.map((entry) => entry.id)).toEqual(['agent_a', 'agent_c'])
    expect(groups[1]?.agents.map((entry) => entry.id)).toEqual(['agent_b'])
  })

  it('keeps an agent whose project cannot be resolved, under its own heading', () => {
    // The case this whole module exists for. An agent naming a project we cannot find right now
    // still exists and still has its identity — the repository may simply have been removed.
    const groups = groupAgentsByProject([agent('agent_a', 'repo:gone')], [project('p1')])

    expect(groups).toEqual([
      { kind: 'unresolved', projectId: 'repo:gone', agents: [agent('agent_a', 'repo:gone')] }
    ])
  })

  it('does NOT fold an unresolved owner into "no project"', () => {
    // Relabelling it would be this surface inventing an ownership change the user never made, and
    // it is indistinguishable afterwards from an agent that genuinely chose no project.
    const groups = groupAgentsByProject(
      [agent('agent_unowned', null), agent('agent_orphan', 'repo:gone')],
      []
    )

    const kinds = groups.map((group) => group.kind)
    expect(kinds).toContain('none')
    expect(kinds).toContain('unresolved')
    expect(groups.find((group) => group.kind === 'none')?.agents).toHaveLength(1)
    expect(groups.find((group) => group.kind === 'unresolved')?.agents).toHaveLength(1)
  })

  it('loses no agent, whatever its ownership', () => {
    const agents = [
      agent('agent_a', 'p1'),
      agent('agent_b', null),
      agent('agent_c', 'repo:gone'),
      agent('agent_d', 'p1')
    ]

    const grouped = groupAgentsByProject(agents, [project('p1')]).flatMap((group) => group.agents)

    expect(grouped.map((entry) => entry.id).sort()).toEqual([
      'agent_a',
      'agent_b',
      'agent_c',
      'agent_d'
    ])
  })

  it('follows a project id promotion without leaving a ghost behind', () => {
    // After succession the agent's projectId has been rewritten to the promoted id, and the
    // project list carries the promoted project. Both sides moved, so there is exactly one group
    // and nothing under the old id — which is what a cached Project->Agents map would get wrong.
    const before = groupAgentsByProject([agent('agent_a', 'repo:r1')], [project('repo:r1', 'App')])
    expect(before[0]).toMatchObject({ kind: 'project' })

    const after = groupAgentsByProject(
      [agent('agent_a', 'github:acme/app')],
      [project('github:acme/app', 'App')]
    )

    expect(after).toHaveLength(1)
    expect(after[0]).toMatchObject({ kind: 'project' })
    expect(after[0]?.agents.map((entry) => entry.id)).toEqual(['agent_a'])
  })

  it('orders project headings the way the project list is ordered, not the roster', () => {
    const groups = groupAgentsByProject(
      [agent('agent_z', 'p2'), agent('agent_a', 'p1')],
      [project('p1'), project('p2')]
    )

    expect(groups.map((group) => (group.kind === 'project' ? group.project.id : group.kind))).toEqual(
      ['p1', 'p2']
    )
  })

  it('emits no empty groups for projects that have no agents', () => {
    const groups = groupAgentsByProject([agent('agent_a', 'p1')], [project('p1'), project('p2')])

    expect(groups).toHaveLength(1)
  })

  it('returns nothing at all for an empty roster, so the page can own the empty state', () => {
    expect(groupAgentsByProject([], [project('p1')])).toEqual([])
  })
})
