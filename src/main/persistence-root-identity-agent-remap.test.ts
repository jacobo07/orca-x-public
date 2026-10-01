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

describe('an agent follows its project from repo: to git-root:', () => {
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

  it('CHARACTERIZATION: strands an agent of the repo that joins an existing git-root: project (live sync)', async () => {
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
    const created = await store.createAgent({ name: 'Planner', role: '', projectId: 'repo:b' })
    expect(created.outcome).toBe('created')

    store.updateRepo('a', { gitRootIdentity: rootOf('a') }, 'local')
    store.updateRepo('b', { gitRootIdentity: rootOf('b') }, 'ssh:srv')

    expect(store.getProjects().map((project) => project.id)).toEqual([ROOT_ID])
    expect(store.getProjects()[0]?.sourceRepoIds).toEqual(['a', 'b'])
    // Stranded: the agent still names a project id that no longer exists.
    expect(store.getAgents().map((agent) => agent.projectId)).toEqual(['repo:b'])
  })

  it('CHARACTERIZATION: strands an agent of the unclaimed predecessor on load (both roots persisted)', async () => {
    const now = 1
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
          createdAt: now,
          updatedAt: 20
        },
        {
          id: 'repo:b',
          displayName: 'b',
          badgeColor: '#737373',
          sourceRepoIds: ['b'],
          createdAt: now,
          updatedAt: 10
        }
      ],
      agents: [
        {
          id: 'agent_1',
          name: 'On a',
          role: '',
          projectId: 'repo:a',
          createdAt: now,
          updatedAt: now
        },
        {
          id: 'agent_2',
          name: 'On b',
          role: '',
          projectId: 'repo:b',
          createdAt: now,
          updatedAt: now
        }
      ]
    })

    const store = await createStore()

    expect(store.getProjects().map((project) => project.id)).toEqual([ROOT_ID])
    // The predecessor that was claimed is followed by the profile rebuild only; the load path leaves both.
    expect(store.getAgents().map((agent) => agent.projectId)).toEqual(['repo:a', 'repo:b'])
  })
})
