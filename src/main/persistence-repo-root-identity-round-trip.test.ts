import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
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

const SHA = 'd'.repeat(40)
const OTHER_SHA = 'e'.repeat(40)
const validRoot = { rootCommit: SHA, commonDir: '/x/.git', shallow: false as const }

function writeReposFile(repoOverrides: Record<string, unknown>): void {
  writeDataFile({
    schemaVersion: 1,
    repos: [{ ...makeRepo(), ...repoOverrides }],
    worktreeMeta: {},
    settings: {},
    ui: {},
    githubCache: { pr: {}, issue: {} },
    workspaceSession: {}
  })
}

async function loadedRepo() {
  const store = await createStore()
  return store.getRepos()[0] as Record<string, unknown>
}

describe('Repo.gitRootIdentity persistence', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-test-'))
  })

  afterEach(() => {
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it.each([
    ['short sha', { rootCommit: 'abc1234', commonDir: '/x/.git', shallow: false }],
    ['empty commonDir', { rootCommit: SHA, commonDir: '', shallow: false }],
    ['shallow true', { rootCommit: SHA, commonDir: '/x/.git', shallow: true }],
    ['a string', 'not-an-object'],
    ['a number', 42]
  ])('drops a malformed persisted root on load (%s)', async (_name, garbage) => {
    writeReposFile({ gitRootIdentity: garbage })

    const repo = await loadedRepo()

    expect('gitRootIdentity' in repo).toBe(false)
  })

  it('drops a malformed persisted none-reason on load', async () => {
    writeReposFile({ gitRootIdentity: null, gitRootIdentityNoneReason: 'exploded' })

    const repo = await loadedRepo()

    expect(repo.gitRootIdentity).toBeNull()
    expect('gitRootIdentityNoneReason' in repo).toBe(false)
  })

  it('drops a none-reason persisted beside a resolved root', async () => {
    writeReposFile({ gitRootIdentity: validRoot, gitRootIdentityNoneReason: 'unborn' })

    const repo = await loadedRepo()

    expect(repo.gitRootIdentity).toEqual(validRoot)
    expect('gitRootIdentityNoneReason' in repo).toBe(false)
  })

  it('ignores a malformed root update', async () => {
    const store = await createStore()
    store.addRepo(makeRepo({ gitRootIdentity: validRoot }))

    store.updateRepo('r1', {
      gitRootIdentity: { rootCommit: 'zz', commonDir: '/y/.git', shallow: false } as never
    })
    store.updateRepo('r1', { gitRootIdentity: 'garbage' as never })

    expect(store.getRepo('r1')!.gitRootIdentity).toEqual(validRoot)
  })

  it('ignores a malformed none-reason update', async () => {
    const store = await createStore()
    store.addRepo(makeRepo({ gitRootIdentity: null, gitRootIdentityNoneReason: 'unborn' }))

    store.updateRepo('r1', { gitRootIdentityNoneReason: 'exploded' as never })

    const repo = store.getRepo('r1')!
    expect(repo.gitRootIdentity).toBeNull()
    expect(repo.gitRootIdentityNoneReason).toBe('unborn')
  })

  it('clears the reason when a resolved root replaces a settled null', async () => {
    const store = await createStore()
    store.addRepo(makeRepo({ gitRootIdentity: null, gitRootIdentityNoneReason: 'unborn' }))

    store.updateRepo('r1', { gitRootIdentity: validRoot })

    const repo = store.getRepo('r1')!
    expect(repo.gitRootIdentity).toEqual(validRoot)
    expect('gitRootIdentityNoneReason' in repo).toBe(false)
  })

  it('replaces a resolved root with a different valid one', async () => {
    const store = await createStore()
    store.addRepo(makeRepo({ gitRootIdentity: validRoot }))

    store.updateRepo('r1', { gitRootIdentity: { ...validRoot, rootCommit: OTHER_SHA } })

    expect(store.getRepo('r1')!.gitRootIdentity).toMatchObject({ rootCommit: OTHER_SHA })
  })

  // Regression pin: hydration rest-spreads unknown fields, so a valid value survives by
  // construction. The cases above are the instrument for sanitization; this one only pins survival.
  it('round-trips valid roots, null with a reason, and absence through save and reload', async () => {
    const store = await createStore()
    store.addRepo(makeRepo({ id: 'resolved', path: '/a', gitRootIdentity: validRoot }))
    store.addRepo(
      makeRepo({
        id: 'none',
        path: '/b',
        gitRootIdentity: null,
        gitRootIdentityNoneReason: 'shallow'
      })
    )
    store.addRepo(makeRepo({ id: 'absent', path: '/c' }))
    store.flush()

    const reloaded = await createStore()
    const byId = new Map(reloaded.getRepos().map((repo) => [repo.id, repo]))

    expect(byId.get('resolved')!.gitRootIdentity).toEqual(validRoot)
    expect(byId.get('none')!.gitRootIdentity).toBeNull()
    expect(byId.get('none')!.gitRootIdentityNoneReason).toBe('shallow')
    expect('gitRootIdentity' in byId.get('absent')!).toBe(false)
    expect('gitRootIdentityNoneReason' in byId.get('absent')!).toBe(false)
  })
})
