import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const electronMocks = vi.hoisted(() => {
  const ipcMain = { on: vi.fn(), removeListener: vi.fn(), emit: vi.fn() }
  return {
    BrowserWindow: { fromId: vi.fn(() => null) },
    webContents: { fromId: vi.fn(() => null) },
    ipcMain,
    app: { getPath: vi.fn(() => '/tmp'), isPackaged: false }
  }
})
vi.mock('electron', () => electronMocks)
vi.mock('../github/client', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  getRepoUpstream: vi.fn().mockResolvedValue(null)
}))
vi.mock('../worktree-root-preparation', () => ({
  prepareLocalWorktreeRootForRepo: vi.fn().mockResolvedValue(undefined)
}))

import { OrcaRuntimeService } from './orca-runtime'

const GIT = [
  '-c',
  'user.name=hwf',
  '-c',
  'user.email=hwf@example.invalid',
  '-c',
  'commit.gpgsign=false'
]

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', [...GIT, ...args], { cwd, encoding: 'utf8' }).trim()
}

async function withTempGitRepo(
  commit: boolean,
  run: (dir: string, root: string | null) => Promise<void>
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'orca-root-identity-setup-'))
  try {
    git(dir, 'init')
    if (commit) {
      git(dir, 'commit', '--allow-empty', '-m', 'root')
    }
    await run(dir, commit ? git(dir, 'rev-list', '--max-parents=0', 'HEAD') : null)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function runtimeWithFakeStore(repos: Record<string, unknown>[]) {
  const projectId = (): string | undefined =>
    (
      repos.find((repo) => repo.gitRootIdentity)?.gitRootIdentity as
        | { rootCommit: string }
        | undefined
    )?.rootCommit
  const store = {
    getRepos: () => [...repos] as never,
    addRepo: (repo: Record<string, unknown>) => repos.push(repo),
    getRepo: (id: string) => repos.find((repo) => repo.id === id) as never,
    updateRepo: (id: string, updates: Record<string, unknown>) => {
      const repo = repos.find((entry) => entry.id === id)
      if (!repo) {
        return null
      }
      Object.assign(repo, updates)
      return { ...repo } as never
    },
    removeProject: (id: string) => {
      const index = repos.findIndex((repo) => repo.id === id)
      if (index !== -1) {
        repos.splice(index, 1)
      }
    },
    // Why: stands in for the projection once repos with a proven root derive git-root ids.
    getProjects: () =>
      projectId() ? ([{ id: `git-root:${projectId()}`, displayName: 'p' }] as never) : [],
    getProjectHostSetups: () =>
      repos
        .filter((repo) => repo.gitRootIdentity)
        .map((repo) => ({
          id: repo.id,
          projectId: `git-root:${projectId()}`,
          repoId: repo.id,
          hostId: 'runtime:env-1',
          path: repo.path
        })) as never,
    getSettings: () => ({ workspaceDir: '/tmp/workspaces', nestWorkspaces: false })
  }
  return new OrcaRuntimeService(store as never)
}

describe('OrcaRuntimeService.setupProjectExistingFolder with a git-root project', () => {
  it('links the folder when its first commit equals the project root', async () => {
    await withTempGitRepo(true, async (dir, root) => {
      const repos: Record<string, unknown>[] = []
      const runtime = runtimeWithFakeStore(repos)

      const result = await runtime.setupProjectExistingFolder({
        projectId: `git-root:${root}`,
        hostId: 'runtime:env-1',
        path: dir,
        kind: 'git',
        setupMethod: 'imported-existing-folder'
      })

      expect(result.project.id).toBe(`git-root:${root}`)
      expect(repos[0]?.gitRootIdentity).toMatchObject({ rootCommit: root, shallow: false })
    })
  })

  it('refuses root_identity_mismatch and removes the repo it created', async () => {
    await withTempGitRepo(true, async (dir) => {
      const repos: Record<string, unknown>[] = []
      const runtime = runtimeWithFakeStore(repos)

      await expect(
        runtime.setupProjectExistingFolder({
          projectId: `git-root:${'9'.repeat(40)}`,
          hostId: 'runtime:env-1',
          path: dir,
          kind: 'git'
        })
      ).rejects.toThrow(/^root_identity_mismatch: /)

      expect(repos).toEqual([])
    })
  })

  it('refuses root_identity_absent for a repository without commits and leaves nothing behind', async () => {
    await withTempGitRepo(false, async (dir) => {
      const repos: Record<string, unknown>[] = []
      const runtime = runtimeWithFakeStore(repos)

      await expect(
        runtime.setupProjectExistingFolder({
          projectId: `git-root:${'9'.repeat(40)}`,
          hostId: 'runtime:env-1',
          path: dir,
          kind: 'git'
        })
      ).rejects.toThrow(/^root_identity_absent: /)

      expect(repos).toEqual([])
      expect(runtime.listProjects()).toEqual([])
      expect(runtime.listProjectHostSetups()).toEqual([])
    })
  })
})
