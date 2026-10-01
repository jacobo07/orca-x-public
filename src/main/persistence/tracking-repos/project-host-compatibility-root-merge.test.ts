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

  it('CHARACTERIZATION: carries one predecessor, leaves a ghost row and an unremapped setup', () => {
    const result = mergeProjectHostSetupCompatibilityState(previous, repos)

    const root = result.projects.find((entry) => entry.id === ROOT_ID)
    expect(root?.connectedApplications?.map((entry) => entry.id)).toEqual(['capp_aaaaaaaa'])
    expect(result.projectHostSetups.find((setup) => setup.id === 'b-extra')?.projectId).toBe(
      'repo:b'
    )
    expect(result.projects.map((entry) => entry.id)).toContain('repo:b')
  })
})
