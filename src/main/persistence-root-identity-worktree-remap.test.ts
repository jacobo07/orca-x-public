import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { getDefaultPersistedState } from '../shared/constants'
import { testState, createStore, writeDataFile, makeRepo } from './persistence-test-harness'

vi.mock('./ssh/ssh-config-parser', () => ({
  loadUserSshConfig: vi.fn(),
  sshConfigHostsToTargets: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf-8').slice('encrypted:'.length)
  }
}))

vi.mock('./telemetry/client', () => ({ track: vi.fn() }))
vi.mock('./telemetry/cohort-classifier', () => ({
  getCohortAtEmit: vi.fn().mockReturnValue({ nth_repo_added: 2 })
}))

const ROOT = 'a'.repeat(40)
const ROOT_ID = `git-root:${ROOT}`
const rootOf = (name: string) => ({
  rootCommit: ROOT,
  commonDir: `/srv/${name}/.git`,
  shallow: false as const
})
const WORKTREE_A = 'a::/srv/a-feature'
const WORKTREE_B = 'b::/srv/b-feature'

describe('a worktree follows its project from repo: to git-root:', () => {
  // The first createStore() pays the cold ./persistence import, which timed out whichever case ran first.
  beforeAll(async () => {
    await import('./persistence')
  }, 30_000)

  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-test-'))
  })

  afterEach(() => {
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('CHARACTERIZATION: leaves WorktreeMeta.projectId on a vanished project id (live sync)', async () => {
    const store = await createStore()
    store.addRepo(makeRepo({ id: 'a', path: '/srv/a', gitRemoteIdentity: null }))
    store.addRepo(
      makeRepo({
        id: 'b',
        path: '/srv/b',
        gitRemoteIdentity: null,
        connectionId: 'srv',
        executionHostId: 'ssh:srv'
      })
    )
    store.setWorktreeMeta(WORKTREE_A, { projectId: 'repo:a' })
    store.setWorktreeMeta(WORKTREE_B, { projectId: 'repo:b' })

    store.updateRepo('a', { gitRootIdentity: rootOf('a') }, 'local')
    store.updateRepo('b', { gitRootIdentity: rootOf('b') }, 'ssh:srv')

    expect(store.getProjects().map((project) => project.id)).toEqual([ROOT_ID])
    expect(store.getWorktreeMeta(WORKTREE_A)?.projectId).toBe('repo:a')
    expect(store.getWorktreeMeta(WORKTREE_B)?.projectId).toBe('repo:b')
  })

  it('CHARACTERIZATION: leaves WorktreeMeta.projectId on a vanished project id (load path)', async () => {
    writeDataFile({
      ...getDefaultPersistedState(testState.dir),
      repos: [
        makeRepo({
          id: 'a',
          path: '/srv/a',
          gitRemoteIdentity: null,
          gitRootIdentity: rootOf('a')
        }),
        makeRepo({
          id: 'b',
          path: '/srv/b',
          gitRemoteIdentity: null,
          gitRootIdentity: rootOf('b'),
          connectionId: 'srv',
          executionHostId: 'ssh:srv'
        })
      ],
      projects: [
        {
          id: 'repo:a',
          displayName: 'a',
          badgeColor: '#737373',
          sourceRepoIds: ['a'],
          createdAt: 1,
          updatedAt: 20
        },
        {
          id: 'repo:b',
          displayName: 'b',
          badgeColor: '#737373',
          sourceRepoIds: ['b'],
          createdAt: 1,
          updatedAt: 10
        }
      ],
      worktreeMeta: {
        [WORKTREE_A]: { projectId: 'repo:a' },
        [WORKTREE_B]: { projectId: 'repo:b' }
      }
    })

    const store = await createStore()

    expect(store.getProjects().map((project) => project.id)).toEqual([ROOT_ID])
    expect(store.getWorktreeMeta(WORKTREE_A)?.projectId).toBe('repo:a')
    expect(store.getWorktreeMeta(WORKTREE_B)?.projectId).toBe('repo:b')
  })
})
