import { describe, expect, it } from 'vitest'
import type { Project, ProjectHostSetup } from '../../../shared/project-types'
import type { Repo } from '../../../shared/repo-types'
import { mergeProjectHostSetupCompatibilityState } from './project-host-compatibility'

const ROOT = 'a'.repeat(40)
const ROOT_ID = `git-root:${ROOT}`

function rootedRepo(id: string, overrides: Partial<Repo> = {}): Repo {
  return {
    id,
    path: `/srv/${id}`,
    displayName: id,
    badgeColor: '#fff',
    addedAt: 1,
    gitRemoteIdentity: null,
    gitRootIdentity: { rootCommit: ROOT, commonDir: `/srv/${id}/.git`, shallow: false },
    ...overrides
  }
}

const project = (overrides: Partial<Project>): Project => ({
  id: 'project-1',
  displayName: 'Project',
  badgeColor: '#737373',
  sourceRepoIds: [],
  createdAt: 1,
  updatedAt: 1,
  ...overrides
})

const independentSetup = (overrides: Partial<ProjectHostSetup>): ProjectHostSetup => ({
  id: 'setup-1',
  projectId: 'project-1',
  hostId: 'local',
  repoId: '',
  path: '/repo',
  displayName: 'Project',
  setupState: 'ready',
  setupMethod: 'imported-existing-folder',
  createdAt: 1,
  updatedAt: 1,
  ...overrides
})

const application = (id: string) => ({
  id: `capp_${id}`,
  label: id,
  origin: `https://${id}.example.com`,
  signInOrigins: [],
  addedAt: 1
})

describe('project host compatibility across a repo: to git-root: merge', () => {
  const repos = [rootedRepo('a'), rootedRepo('b', { connectionId: 't1' })]
  const previous = {
    projects: [
      project({
        id: 'repo:a',
        sourceRepoIds: ['a'],
        updatedAt: 20,
        localWindowsRuntimePreference: { kind: 'wsl' as const, distro: 'Ubuntu' },
        connectedApplications: [application('aaaaaaaa')]
      }),
      project({
        id: 'repo:b',
        sourceRepoIds: ['b'],
        updatedAt: 10,
        connectedApplications: [application('bbbbbbbb')]
      })
    ],
    projectHostSetups: [
      independentSetup({
        id: 'b-extra',
        projectId: 'repo:b',
        hostId: 'ssh:t2',
        path: '/srv/b-extra'
      })
    ]
  }

  it('carries both predecessors, remaps the independent setup and leaves no ghost row', () => {
    const result = mergeProjectHostSetupCompatibilityState(previous, repos)

    const root = result.projects.find((entry) => entry.id === ROOT_ID)
    expect(root?.connectedApplications?.map((entry) => entry.id)).toEqual([
      'capp_aaaaaaaa',
      'capp_bbbbbbbb'
    ])
    expect(result.projectHostSetups.find((setup) => setup.id === 'b-extra')?.projectId).toBe(
      ROOT_ID
    )
    expect(result.projects.map((entry) => entry.id)).toEqual([ROOT_ID])
  })

  it('keeps the preference of the predecessor that holds the local repo', () => {
    // `b` is newer (the primary) and holds the ssh replica; `a` holds the local one.
    const newerRemote = {
      ...previous,
      projects: previous.projects.map((entry) =>
        entry.id === 'repo:b'
          ? {
              ...entry,
              updatedAt: 99,
              localWindowsRuntimePreference: { kind: 'windows-host' as const }
            }
          : entry
      )
    }

    const result = mergeProjectHostSetupCompatibilityState(newerRemote, repos)

    expect(
      result.projects.find((entry) => entry.id === ROOT_ID)?.localWindowsRuntimePreference
    ).toEqual({ kind: 'wsl', distro: 'Ubuntu' })
  })

  it('returns the dependents it was handed, remapped, and none it was not handed', () => {
    const agents = [
      { id: 'agent_1', name: 'On b', role: '', projectId: 'repo:b', createdAt: 1, updatedAt: 1 },
      { id: 'agent_2', name: 'Free', role: '', projectId: null, createdAt: 1, updatedAt: 1 }
    ]
    const worktreeMeta = { 'b::/srv/b-feature': { projectId: 'repo:b' } } as never

    const withDependents = mergeProjectHostSetupCompatibilityState(
      { ...previous, agents, worktreeMeta },
      repos
    )
    const without = mergeProjectHostSetupCompatibilityState(previous, repos)

    expect(withDependents.agents?.map((agent) => agent.projectId)).toEqual([ROOT_ID, null])
    expect(withDependents.worktreeMeta?.['b::/srv/b-feature']?.projectId).toBe(ROOT_ID)
    expect(without).not.toHaveProperty('agents')
    expect(without).not.toHaveProperty('worktreeMeta')
  })
})
