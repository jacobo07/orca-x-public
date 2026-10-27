import { describe, expect, it } from 'vitest'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { Project, ProjectHostSetup } from '../../../../shared/project-types'
import { buildAgentProjectChoices, filterAgentProjectChoices } from './agent-project-choices'

function project(id: string, displayName: string): Project {
  return { id, displayName, badgeColor: '#000', sourceRepoIds: [], createdAt: 0, updatedAt: 0 }
}

function setup(
  projectId: string,
  hostId: ExecutionHostId,
  path: string,
  setupState: ProjectHostSetup['setupState'] = 'ready'
): ProjectHostSetup {
  return {
    id: `${projectId}@${hostId}`,
    projectId,
    hostId,
    repoId: `repo-${projectId}-${hostId}`,
    path,
    displayName: projectId,
    setupState,
    setupMethod: 'legacy-repo',
    createdAt: 0,
    updatedAt: 0
  }
}

const HOSTS = new Map([
  ['local' as ExecutionHostId, { label: 'This computer', health: 'local' as const }],
  ['ssh:gex44' as ExecutionHostId, { label: 'GEX44', health: 'disconnected' as const }]
])

describe('agent project choices', () => {
  it('lists a project set up on two hosts once, naming both hosts', () => {
    const [choice] = buildAgentProjectChoices(
      [project('github:o/orca', 'Orca X')],
      [
        setup('github:o/orca', 'local', 'C:\\orca'),
        setup('github:o/orca', 'ssh:gex44', '/home/k/orca')
      ],
      HOSTS
    )
    expect(choice.hosts.map((host) => host.label)).toEqual(['This computer', 'GEX44'])
    expect(choice.hosts[1].health).toBe('disconnected')
  })

  it('marks two projects that share a name so the picker can show their paths', () => {
    const choices = buildAgentProjectChoices(
      [project('p1', 'Orca X'), project('p2', 'orca x'), project('p3', 'Studio')],
      [setup('p1', 'local', 'C:\\a'), setup('p2', 'local', 'C:\\b')],
      HOSTS
    )
    expect(choices.map((choice) => choice.sharesName)).toEqual([true, true, false])
    expect(choices[1].path).toBe('C:\\b')
  })

  it('counts only ready setups, and keeps an unregistered host visible without a state', () => {
    const [choice] = buildAgentProjectChoices(
      [project('p1', 'App')],
      [
        setup('p1', 'ssh:gone' as ExecutionHostId, '/x', 'ready'),
        setup('p1', 'local', '/y', 'error')
      ],
      HOSTS
    )
    expect(choice.hosts).toEqual([
      { id: 'ssh:gone', label: 'ssh:gone', health: null, repoId: 'repo-p1-ssh:gone' }
    ])
    expect(choice.path).toBe('/x')
  })

  it('filters by name, path or host label', () => {
    const choices = buildAgentProjectChoices(
      [project('p1', 'Orca X'), project('p2', 'Studio')],
      [setup('p1', 'ssh:gex44', '/home/k/orca'), setup('p2', 'local', 'C:\\studio')],
      HOSTS
    )
    expect(filterAgentProjectChoices(choices, 'gex').map((c) => c.projectId)).toEqual(['p1'])
    expect(filterAgentProjectChoices(choices, 'STUDIO').map((c) => c.projectId)).toEqual(['p2'])
    expect(filterAgentProjectChoices(choices, '  ')).toHaveLength(2)
  })
})
