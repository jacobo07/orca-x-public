import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as GitRunner from '../git/runner'
import type * as RepoModule from '../git/repo'

const { reposMocks, moduleMocks, probeMock } = await vi.hoisted(async () => {
  const moduleMocks = await import('./repos-remote-test-harness')
  return { reposMocks: moduleMocks.createReposIpcMocks(), moduleMocks, probeMock: vi.fn() }
})

vi.mock('electron', () => moduleMocks.electronModuleMock(reposMocks))
vi.mock('../git/repo', async (importOriginal) =>
  moduleMocks.gitRepoModuleMock(await importOriginal<typeof RepoModule>())
)
vi.mock('../git/runner', async (importOriginal) =>
  moduleMocks.gitRunnerModuleMock(reposMocks, await importOriginal<typeof GitRunner>())
)
vi.mock('../git/worktree', () => moduleMocks.gitWorktreeModuleMock(reposMocks))
vi.mock('./registered-worktree-roots-cache', () =>
  moduleMocks.registeredWorktreeRootsCacheModuleMock(reposMocks)
)
vi.mock('../worktree-root-preparation', () =>
  moduleMocks.worktreeRootPreparationModuleMock(reposMocks)
)
vi.mock('../providers/ssh-git-dispatch', () => moduleMocks.sshGitDispatchModuleMock(reposMocks))
vi.mock('../providers/ssh-filesystem-dispatch', () =>
  moduleMocks.sshFilesystemDispatchModuleMock(reposMocks)
)
vi.mock('./ssh', () => moduleMocks.sshModuleMock(reposMocks))
vi.mock('../repo-git-root-identity', () => ({ probeGitRootIdentity: probeMock }))

import { registerRepoHandlers } from './repos'
import { clearGitCapabilityStateForTests } from '../git/git-capability-state'
import { resetSshProviderAuthorities } from '../ssh/ssh-provider-authority'
import { createRepoHandlerHarness, resetLocalRepoMocks } from './repos-remote-test-harness'

const { handleMock, mockStore, invalidateAuthorizedRootsCacheMock } = reposMocks

const ROOT = '1'.repeat(40)
const SETUP_ARGS = {
  projectId: `git-root:${ROOT}`,
  hostId: 'local',
  path: '/tmp/root-identity-folder',
  kind: 'git',
  setupMethod: 'imported-existing-folder'
}

beforeEach(() => {
  clearGitCapabilityStateForTests()
  resetSshProviderAuthorities()
  probeMock.mockReset()
})

describe('projectHostSetups:setupExistingFolder with a git-root project', () => {
  const { handlers, mockWindow, captureHandlers } = createRepoHandlerHarness()
  let added: Record<string, unknown>[]

  beforeEach(() => {
    captureHandlers(handleMock)
    resetLocalRepoMocks(reposMocks)
    mockWindow.webContents.send.mockReset()
    added = []
    mockStore.removeProject.mockReset()
    invalidateAuthorizedRootsCacheMock.mockClear()
    mockStore.getRepos.mockImplementation(() => added)
    mockStore.addRepo.mockImplementation((repo: Record<string, unknown>) => added.push(repo))
    mockStore.removeProject.mockImplementation((id: string) => {
      added = added.filter((entry) => entry.id !== id)
    })
    mockStore.updateRepo.mockImplementation((id: string, updates: Record<string, unknown>) => {
      const repo = added.find((entry) => entry.id === id)
      if (!repo) {
        return null
      }
      Object.assign(repo, updates)
      return { ...repo }
    })
    // Why: stands in for the projection once repos with a proven root derive git-root ids.
    mockStore.getProjects.mockImplementation(() =>
      added.some((repo) => repo.gitRootIdentity)
        ? [{ id: SETUP_ARGS.projectId, displayName: 'p' }]
        : []
    )
    mockStore.getProjectHostSetups.mockImplementation(() =>
      added
        .filter((repo) => repo.gitRootIdentity)
        .map((repo) => ({
          id: repo.id,
          projectId: SETUP_ARGS.projectId,
          repoId: repo.id,
          hostId: 'local',
          path: repo.path
        }))
    )
    registerRepoHandlers(mockWindow as never, mockStore as never)
  })

  it('links the new folder when its probed root equals the project root', async () => {
    probeMock.mockResolvedValue({
      status: 'resolved',
      identity: { rootCommit: ROOT, commonDir: '/tmp/root-identity-folder/.git', shallow: false }
    })

    const result = await handlers.get('projectHostSetups:setupExistingFolder')!(null, SETUP_ARGS)

    expect(added[0]?.gitRootIdentity).toEqual({
      rootCommit: ROOT,
      commonDir: '/tmp/root-identity-folder/.git',
      shallow: false
    })
    expect(result).toHaveProperty('project.id', SETUP_ARGS.projectId)
    expect(mockStore.removeProject).not.toHaveBeenCalled()
  })

  it.each([
    [
      'root_identity_mismatch',
      {
        status: 'resolved',
        identity: { rootCommit: '2'.repeat(40), commonDir: '/x/.git', shallow: false }
      }
    ],
    ['root_identity_unavailable', { status: 'unavailable' }],
    ['root_identity_absent', { status: 'settled-none', reason: 'unborn' }]
  ])('refuses %s and leaves no repo, project or setup behind', async (code, probe) => {
    probeMock.mockResolvedValue(probe)

    await expect(
      handlers.get('projectHostSetups:setupExistingFolder')!(null, SETUP_ARGS)
    ).rejects.toThrow(new RegExp(`^${code}: `))

    expect(added).toEqual([])
    expect(mockStore.getProjects()).toEqual([])
    expect(mockStore.getProjectHostSetups()).toEqual([])
    expect(mockStore.removeProject).toHaveBeenCalledTimes(1)
    expect(invalidateAuthorizedRootsCacheMock).toHaveBeenCalled()
  })

  it('refuses root_identity_collision when the host already holds another repository with that root', async () => {
    added.push({
      id: 'held',
      path: '/tmp/held',
      displayName: 'held',
      kind: 'git',
      badgeColor: '#737373',
      addedAt: 1,
      gitRemoteIdentity: null,
      gitRootIdentity: { rootCommit: ROOT, commonDir: '/tmp/held/.git', shallow: false }
    })
    probeMock.mockResolvedValue({
      status: 'resolved',
      identity: { rootCommit: ROOT, commonDir: '/tmp/root-identity-folder/.git', shallow: false }
    })

    await expect(
      handlers.get('projectHostSetups:setupExistingFolder')!(null, SETUP_ARGS)
    ).rejects.toThrow(/^root_identity_collision: /)

    expect(added.map((repo) => repo.id)).toEqual(['held'])
  })
})
