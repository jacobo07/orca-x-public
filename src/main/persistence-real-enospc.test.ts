// The profile data file (persistence.profile-data-file) on a real full filesystem, nothing mocked at the
// fs boundary. persistence-write-failure-semantics.test.ts injects ENOSPC and proves what the store does
// with one; this file pins the premise to the kernel: a genuinely full volume produces the code, the
// previous file survives byte-identical, no temp file stays, and recovery publishes.
//
// Opt-in through ORCA_ENOSPC_VOLUME (see real-enospc-volume-test-harness.ts and
// config/scripts/real-enospc-volume.sh). Observations are logged as `REAL_ENOSPC ` lines for the runner.
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createStore,
  dataFile,
  makeRepo,
  readDataFile,
  testState
} from './persistence-test-harness'
import {
  fillRealEnospcVolume,
  realEnospcVolume,
  realEnospcVolumeUnusableReason
} from './real-enospc-volume-test-harness'

vi.mock('./ssh/ssh-config-parser', () => ({
  loadUserSshConfig: vi.fn(),
  sshConfigHostsToTargets: vi.fn()
}))
vi.mock('./telemetry/client', () => ({ track: vi.fn() }))
vi.mock('./telemetry/cohort-classifier', () => ({
  getCohortAtEmit: vi.fn().mockReturnValue({ nth_repo_added: 2 })
}))
vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`enc:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf-8').slice('enc:'.length)
  }
}))

const volume = realEnospcVolume()
const skipReason = realEnospcVolumeUnusableReason()

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function tempSiblings(): string[] {
  return readdirSync(testState.dir).filter((name) => name.endsWith('.tmp'))
}

function publishedRepoIds(): string[] {
  return (readDataFile() as { repos: { id: string }[] }).repos.map((repo) => repo.id)
}

/** The observed failure, as the runner greps it: which code, from which syscall, at which publish stage. */
function observed(label: string, error: unknown, before: string, after: string): void {
  const failure = error as { code?: string; syscall?: string; stage?: string; name?: string }
  console.info(
    `REAL_ENOSPC case=${label} code=${failure.code ?? 'none'} syscall=${failure.syscall ?? 'none'} ` +
      `stage=${failure.stage ?? 'none'} error=${failure.name ?? 'none'} sha_before=${before.slice(0, 16)} ` +
      `sha_after=${after.slice(0, 16)} identical=${before === after}`
  )
}

describe.skipIf(skipReason !== null)('profile data file on a real full filesystem', () => {
  let ballast: string

  beforeEach(() => {
    testState.dir = mkdtempSync(join(volume, 'profile-'))
    ballast = join(volume, 'profile-ballast.bin')
  })

  afterEach(() => {
    rmSync(ballast, { force: true })
    rmSync(testState.dir, { recursive: true, force: true })
  })

  async function storeWithPublishedRepo(): Promise<{
    store: Awaited<ReturnType<typeof createStore>>
    publishedHash: string
  }> {
    const store = await createStore()
    store.addRepo(makeRepo({ id: 'published' }))
    await store.flushPendingOrThrowAsync()
    expect(publishedRepoIds()).toEqual(['published'])
    store.addRepo(makeRepo({ id: 'pending', path: '/repo-pending' }))
    return { store, publishedHash: sha256(dataFile()) }
  }

  it('control: with room on the volume the pending repo is published', async () => {
    const { store } = await storeWithPublishedRepo()

    await store.flushPendingOrThrowAsync()

    expect(publishedRepoIds()).toEqual(['published', 'pending'])
    expect(tempSiblings()).toEqual([])
  })

  it('async flush rejects with the kernel ENOSPC, keeps the previous file byte-identical, leaves no temp file and publishes once space is freed', async () => {
    const { store, publishedHash } = await storeWithPublishedRepo()
    const filled = fillRealEnospcVolume(ballast)
    expect(
      filled,
      'nothing was written as ballast; the volume was full before we began'
    ).toBeGreaterThan(0)

    const failure = await store.flushPendingOrThrowAsync().then(
      () => null,
      (error: NodeJS.ErrnoException) => error
    )

    expect(failure, 'the flush on a full volume must reject, not resolve').not.toBeNull()
    expect(failure?.code).toBe('ENOSPC')
    observed('profile-async-flush', failure, publishedHash, sha256(dataFile()))
    expect(sha256(dataFile())).toBe(publishedHash)
    expect(tempSiblings()).toEqual([])
    expect(publishedRepoIds()).toEqual(['published'])

    rmSync(ballast, { force: true })
    await store.flushPendingOrThrowAsync()

    expect(publishedRepoIds()).toEqual(['published', 'pending'])
    expect(tempSiblings()).toEqual([])
    const reloaded = await createStore()
    expect(reloaded.getRepos().map((repo) => repo.id)).toEqual(['published', 'pending'])
  })

  it('sync flush throws a DurablePublishError carrying the kernel ENOSPC and keeps the previous file', async () => {
    const { store, publishedHash } = await storeWithPublishedRepo()
    fillRealEnospcVolume(ballast)

    let failure: unknown = null
    try {
      store.flushOrThrow()
    } catch (error) {
      failure = error
    }

    expect(failure, 'the sync flush on a full volume must throw').not.toBeNull()
    // Why by name: createStore resets the module registry, so the class identity differs.
    expect((failure as Error).name).toBe('DurablePublishError')
    expect((failure as NodeJS.ErrnoException).code).toBe('ENOSPC')
    observed('profile-sync-flush', failure, publishedHash, sha256(dataFile()))
    expect(sha256(dataFile())).toBe(publishedHash)
    expect(tempSiblings()).toEqual([])

    rmSync(ballast, { force: true })
    store.flushOrThrow()

    expect(publishedRepoIds()).toEqual(['published', 'pending'])
  })
})

if (skipReason !== null) {
  // Say why, every run. A silent skip is indistinguishable from a passing gate.
  console.info(`[real-enospc] persistence skipped: ${skipReason}`)
}
