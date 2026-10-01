import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestStore } from './store-test-helpers'
import type { Repo } from '../../../../shared/repo-types'
import { projectHostSetupProjectionFromRepos } from '../../../../shared/project-host-setup-projection'

// The 16-05 real two-host run: a remote-less repo on the laptop and on a direct-SSH host groups
// as `git-root:R`; a same-root fork on that SSH host then demotes the SSH replica to `repo:`.
const ROOT = 'a'.repeat(40)
const ROOT_PROJECT_ID = `git-root:${ROOT}`
const SSH_TARGET = 'ssh-gex44'
const SSH_HOST_ID = `ssh:${SSH_TARGET}`

function localRepo(): Repo {
  return {
    id: 'repo-a',
    path: 'C:/work/hwf',
    displayName: 'hwf',
    badgeColor: '#22c55e',
    addedAt: 1_700_000_000_000,
    gitRemoteIdentity: null,
    gitRootIdentity: { rootCommit: ROOT, commonDir: 'C:/work/hwf/.git', shallow: false }
  }
}

function sshRepo(id: string, commonDir: string | null, extra: Partial<Repo> = {}): Repo {
  return {
    id,
    path: `/srv/${id}`,
    displayName: id,
    badgeColor: '#737373',
    addedAt: 1_700_000_001_000,
    connectionId: SSH_TARGET,
    executionHostId: SSH_HOST_ID,
    gitRemoteIdentity: null,
    gitRootIdentity: commonDir ? { rootCommit: ROOT, commonDir, shallow: false } : null,
    ...extra
  }
}

let mainRepos: Repo[] = []

// Why: main publishes the projection of its whole repo set; deriving the mock from the real
// projection keeps the fixture from inventing a catalog main never sends.
function mainCatalog() {
  return projectHostSetupProjectionFromRepos(mainRepos)
}

beforeEach(() => {
  mainRepos = [localRepo(), sshRepo('repo-b', '/srv/repo-b/.git')]
  vi.stubGlobal('window', {
    api: {
      repos: { list: vi.fn(async () => structuredClone(mainRepos)) },
      projects: {
        list: vi.fn(async () => structuredClone([...mainCatalog().projects])),
        listHostSetups: vi.fn(async () => structuredClone([...mainCatalog().setups]))
      },
      projectGroups: { list: vi.fn().mockResolvedValue([]) },
      folderWorkspaces: { list: vi.fn().mockResolvedValue([]) },
      runtimeEnvironments: { call: vi.fn(), list: vi.fn().mockResolvedValue([]) }
    },
    dispatchEvent: vi.fn()
  })
})

function addSameHostForkAndOrphans(): void {
  mainRepos = [
    ...mainRepos,
    sshRepo('repo-f', '/srv/repo-f/.git'),
    sshRepo('repo-s', null, { gitRootIdentityNoneReason: 'shallow' }),
    sshRepo('repo-u', null, { gitRootIdentityNoneReason: 'unborn' })
  ]
}

function projectView(store: ReturnType<typeof createTestStore>) {
  return Object.fromEntries(
    store.getState().projects.map((project) => [project.id, [...project.sourceRepoIds].sort()])
  )
}

function expectSetupsAgreeWithProjects(store: ReturnType<typeof createTestStore>): void {
  const projects = new Map(store.getState().projects.map((project) => [project.id, project]))
  for (const setup of store.getState().projectHostSetups) {
    expect(projects.get(setup.projectId)?.sourceRepoIds, setup.id).toContain(setup.repoId)
  }
}

const DEMOTED_VIEW = {
  [ROOT_PROJECT_ID]: ['repo-a'],
  'repo:repo-b': ['repo-b'],
  'repo:repo-f': ['repo-f'],
  'repo:repo-s': ['repo-s'],
  'repo:repo-u': ['repo-u']
}

describe('same-host fork demotes a cross-host root project (local catalog)', () => {
  it('drops the SSH replica from git-root:R and lists a repo: project per SSH repo', async () => {
    const store = createTestStore()
    store.setState({ settings: { activeRuntimeEnvironmentId: null } as never })
    await store.getState().fetchRepos()
    expect(projectView(store)).toEqual({ [ROOT_PROJECT_ID]: ['repo-a', 'repo-b'] })

    addSameHostForkAndOrphans()
    await store.getState().fetchRepos()

    expect(projectView(store)).toEqual(DEMOTED_VIEW)
    expectSetupsAgreeWithProjects(store)
  })

  it('lists the SSH replica before its root probe and leaves no repo: ghost once it groups', async () => {
    mainRepos = [localRepo(), sshRepo('repo-b', null)]
    delete mainRepos[1]!.gitRootIdentity
    const store = createTestStore()
    store.setState({ settings: { activeRuntimeEnvironmentId: null } as never })
    await store.getState().fetchRepos()
    expect(projectView(store)).toEqual({
      [ROOT_PROJECT_ID]: ['repo-a'],
      'repo:repo-b': ['repo-b']
    })

    mainRepos = [localRepo(), sshRepo('repo-b', '/srv/repo-b/.git')]
    await store.getState().fetchRepos()

    expect(projectView(store)).toEqual({ [ROOT_PROJECT_ID]: ['repo-a', 'repo-b'] })
    expectSetupsAgreeWithProjects(store)
  })

  it('lists the same projects after a reload into a fresh renderer', async () => {
    addSameHostForkAndOrphans()
    const store = createTestStore()
    store.setState({ settings: { activeRuntimeEnvironmentId: null } as never })
    await store.getState().fetchRepos()

    expect(projectView(store)).toEqual(DEMOTED_VIEW)
    expectSetupsAgreeWithProjects(store)
  })
})
