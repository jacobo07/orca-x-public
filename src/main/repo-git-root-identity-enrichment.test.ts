import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GitRootIdentity } from '../shared/git-root-identity'
import type { GitRootProbeResult } from '../shared/git-root-identity'
import type { Repo } from '../shared/repo-types'
import {
  enrichMissingRepoGitRemoteIdentities,
  resetRepoGitRemoteIdentityEnrichmentForTests
} from './repo-git-remote-identity-enrichment'
import {
  enrichMissingRepoGitRootIdentities,
  flushRepoGitRootIdentityEnrichmentForTests,
  resetRepoGitRootIdentityEnrichmentForTests,
  type RepoGitRootIdentityStore
} from './repo-git-root-identity-enrichment'
import { probeGitRootIdentity } from './repo-git-root-identity'
import { probeGitRemoteIdentity } from './repo-git-remote-identity'

vi.mock('./repo-git-root-identity', () => ({ probeGitRootIdentity: vi.fn() }))
vi.mock('./repo-git-remote-identity', () => ({
  probeGitRemoteIdentity: vi.fn().mockResolvedValue({ status: 'unavailable' })
}))

const MISS_TTL_MS = 5 * 60 * 1000
const REFRESH_STARTUP_DELAY_MS = 5 * 60 * 1000
const REFRESH_TTL_MS = 6 * 60 * 60 * 1000

const rootA: GitRootIdentity = {
  rootCommit: 'a'.repeat(40),
  commonDir: '/w/a/.git',
  shallow: false
}
const rootB: GitRootIdentity = {
  rootCommit: 'b'.repeat(40),
  commonDir: '/w/a/.git',
  shallow: false
}
const resolvedA: GitRootProbeResult = { status: 'resolved', identity: rootA }
const unavailable: GitRootProbeResult = { status: 'unavailable' }
const unborn: GitRootProbeResult = { status: 'settled-none', reason: 'unborn' }

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-1',
    path: '/w/a',
    displayName: 'a',
    badgeColor: '#737373',
    addedAt: 1,
    kind: 'git',
    ...overrides
  }
}

function makeStore(...repos: Repo[]): RepoGitRootIdentityStore & {
  updateRepo: ReturnType<typeof vi.fn>
} {
  return {
    getRepos: () => repos,
    getRepo: (id) => repos.find((candidate) => candidate.id === id),
    updateRepo: vi.fn((id, updates) => {
      const target = repos.find((candidate) => candidate.id === id)
      if (!target) {
        return null
      }
      Object.assign(target, updates)
      if (updates.gitRootIdentityNoneReason === undefined) {
        delete target.gitRootIdentityNoneReason
      }
      return target
    })
  }
}

async function drain(): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await flushRepoGitRootIdentityEnrichmentForTests()
  }
}

async function rootSweep(store: RepoGitRootIdentityStore): Promise<void> {
  enrichMissingRepoGitRootIdentities(store)
  await drain()
}

// The remote entrypoint is what the six list-call triggers invoke, so W2 re-probes go through it.
async function listCallSweep(store: RepoGitRootIdentityStore): Promise<void> {
  enrichMissingRepoGitRemoteIdentities(store)
  await drain()
}

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
  resetRepoGitRootIdentityEnrichmentForTests()
  resetRepoGitRemoteIdentityEnrichmentForTests()
})

describe('enrichMissingRepoGitRootIdentities', () => {
  it('writes a resolved root and clears a stale none-reason', async () => {
    vi.mocked(probeGitRootIdentity).mockResolvedValue(resolvedA)
    const repo = makeRepo({ gitRootIdentity: null, gitRootIdentityNoneReason: 'unborn' })
    const onChanged = vi.fn()

    enrichMissingRepoGitRootIdentities(makeStore(repo), { onChanged })
    await drain()

    expect(repo.gitRootIdentity).toEqual(rootA)
    expect('gitRootIdentityNoneReason' in repo).toBe(false)
    expect(onChanged).toHaveBeenCalledTimes(1)
  })

  it('writes a settled none with its reason once, without rewriting an equal one', async () => {
    vi.useFakeTimers()
    vi.mocked(probeGitRootIdentity).mockResolvedValue(unborn)
    const repo = makeRepo()
    const store = makeStore(repo)

    await rootSweep(store)
    expect(repo.gitRootIdentity).toBeNull()
    expect(repo.gitRootIdentityNoneReason).toBe('unborn')
    expect(store.updateRepo).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(MISS_TTL_MS + 1)
    await rootSweep(store)
    expect(probeGitRootIdentity).toHaveBeenCalledTimes(2)
    expect(store.updateRepo).toHaveBeenCalledTimes(1)
  })

  it('writes nothing when the probe is unavailable and retries after the miss TTL', async () => {
    vi.useFakeTimers()
    vi.mocked(probeGitRootIdentity).mockResolvedValue(unavailable)
    const repo = makeRepo()
    const store = makeStore(repo)

    await rootSweep(store)
    expect(repo.gitRootIdentity).toBeUndefined()
    expect(store.updateRepo).not.toHaveBeenCalled()

    await rootSweep(store)
    expect(probeGitRootIdentity).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(MISS_TTL_MS + 1)
    await rootSweep(store)
    expect(probeGitRootIdentity).toHaveBeenCalledTimes(2)
    expect(repo.gitRootIdentity).toBeUndefined()
  })

  it('heals an unborn repo that gains a commit on a list-call sweep after the miss TTL', async () => {
    vi.useFakeTimers()
    vi.mocked(probeGitRootIdentity).mockResolvedValue(unborn)
    const repo = makeRepo()
    const store = makeStore(repo)
    await listCallSweep(store)
    expect(repo.gitRootIdentity).toBeNull()
    expect(repo.gitRootIdentityNoneReason).toBe('unborn')

    vi.mocked(probeGitRootIdentity).mockResolvedValue(resolvedA)
    vi.advanceTimersByTime(MISS_TTL_MS - 1000)
    await listCallSweep(store)
    expect(probeGitRootIdentity).toHaveBeenCalledTimes(1)
    expect(repo.gitRootIdentity).toBeNull()

    vi.advanceTimersByTime(2000)
    await listCallSweep(store)
    expect(probeGitRootIdentity).toHaveBeenCalledTimes(2)
    expect(repo.gitRootIdentity).toEqual(rootA)
    expect('gitRootIdentityNoneReason' in repo).toBe(false)
  })

  it('heals a shallow repo that is unshallowed', async () => {
    vi.useFakeTimers()
    vi.mocked(probeGitRootIdentity).mockResolvedValue({ status: 'settled-none', reason: 'shallow' })
    const repo = makeRepo()
    const store = makeStore(repo)
    await listCallSweep(store)
    expect(repo.gitRootIdentityNoneReason).toBe('shallow')

    vi.mocked(probeGitRootIdentity).mockResolvedValue(resolvedA)
    vi.advanceTimersByTime(MISS_TTL_MS + 1)
    await listCallSweep(store)
    expect(repo.gitRootIdentity).toEqual(rootA)
    expect('gitRootIdentityNoneReason' in repo).toBe(false)
  })

  it('refreshes a resolved root only after startup delay plus its deadline', async () => {
    vi.useFakeTimers()
    vi.mocked(probeGitRootIdentity).mockResolvedValue(resolvedA)
    const repo = makeRepo({ gitRootIdentity: rootA })
    const store = makeStore(repo)

    await rootSweep(store)
    expect(probeGitRootIdentity).not.toHaveBeenCalled()

    vi.advanceTimersByTime(REFRESH_STARTUP_DELAY_MS + 1)
    await rootSweep(store)
    expect(probeGitRootIdentity).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(REFRESH_TTL_MS - 1000)
    await rootSweep(store)
    expect(probeGitRootIdentity).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(2000)
    await rootSweep(store)
    expect(probeGitRootIdentity).toHaveBeenCalledTimes(2)
  })

  it('refreshes at most four resolved repos per sweep', async () => {
    vi.useFakeTimers()
    vi.mocked(probeGitRootIdentity).mockResolvedValue(resolvedA)
    const repos = Array.from({ length: 6 }, (_, index) =>
      makeRepo({ id: `repo-${index}`, path: `/w/${index}`, gitRootIdentity: rootA })
    )
    const store = makeStore(...repos)
    await rootSweep(store)
    vi.advanceTimersByTime(REFRESH_STARTUP_DELAY_MS + 1)

    await rootSweep(store)

    expect(probeGitRootIdentity).toHaveBeenCalledTimes(4)
  })

  it('never replaces a resolved root with a settled none or an unavailable probe', async () => {
    vi.useFakeTimers()
    const repo = makeRepo({ gitRootIdentity: rootA })
    const store = makeStore(repo)
    await rootSweep(store)
    vi.advanceTimersByTime(REFRESH_STARTUP_DELAY_MS + 1)

    vi.mocked(probeGitRootIdentity).mockResolvedValue(unborn)
    await rootSweep(store)
    expect(repo.gitRootIdentity).toEqual(rootA)

    vi.advanceTimersByTime(REFRESH_TTL_MS + 1)
    vi.mocked(probeGitRootIdentity).mockResolvedValue(unavailable)
    await rootSweep(store)
    expect(repo.gitRootIdentity).toEqual(rootA)
    expect(store.updateRepo).not.toHaveBeenCalled()
  })

  it('replaces a resolved root with a resolved root whose commit differs', async () => {
    vi.useFakeTimers()
    const repo = makeRepo({ gitRootIdentity: rootA })
    const store = makeStore(repo)
    await rootSweep(store)
    vi.advanceTimersByTime(REFRESH_STARTUP_DELAY_MS + 1)

    vi.mocked(probeGitRootIdentity).mockResolvedValue({ status: 'resolved', identity: rootB })
    await rootSweep(store)

    expect(repo.gitRootIdentity).toEqual(rootB)
  })

  it('never probes a folder repo', async () => {
    vi.mocked(probeGitRootIdentity).mockResolvedValue(resolvedA)
    const folder = makeRepo({ kind: 'folder' })

    await rootSweep(makeStore(folder))

    expect(probeGitRootIdentity).not.toHaveBeenCalled()
    expect(folder.gitRootIdentity).toBeUndefined()
  })

  it('does not write when the repo path changed between snapshot and write', async () => {
    let release!: (value: GitRootProbeResult) => void
    vi.mocked(probeGitRootIdentity).mockReturnValue(
      new Promise<GitRootProbeResult>((resolve) => {
        release = resolve
      })
    )
    const repo = makeRepo()
    const store = makeStore(repo)

    enrichMissingRepoGitRootIdentities(store)
    repo.path = '/w/moved'
    release(resolvedA)
    await drain()

    expect(store.updateRepo).not.toHaveBeenCalled()
    expect(repo.gitRootIdentity).toBeUndefined()
  })

  it('shares one probe between concurrent sweeps for one location', async () => {
    let release!: (value: GitRootProbeResult) => void
    vi.mocked(probeGitRootIdentity).mockReturnValue(
      new Promise<GitRootProbeResult>((resolve) => {
        release = resolve
      })
    )
    const store = makeStore(makeRepo())

    enrichMissingRepoGitRootIdentities(store)
    enrichMissingRepoGitRootIdentities(store)
    release(resolvedA)
    await drain()

    expect(probeGitRootIdentity).toHaveBeenCalledTimes(1)
  })

  it('passes the connection id so an SSH repo is probed on its own host', async () => {
    vi.mocked(probeGitRootIdentity).mockResolvedValue(resolvedA)

    await rootSweep(makeStore(makeRepo({ path: '/srv/x', connectionId: 'builder' })))

    expect(probeGitRootIdentity).toHaveBeenCalledWith('/srv/x', 'builder')
  })

  it('is driven by the remote entrypoint, so the list-call triggers need no new wiring', async () => {
    vi.mocked(probeGitRootIdentity).mockResolvedValue(resolvedA)
    const repo = makeRepo()

    await listCallSweep(makeStore(repo))

    expect(probeGitRemoteIdentity).toHaveBeenCalled()
    expect(probeGitRootIdentity).toHaveBeenCalledTimes(1)
    expect(repo.gitRootIdentity).toEqual(rootA)
  })
})
