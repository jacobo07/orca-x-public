// The profile data file (persistence.profile-data-file) on a real full filesystem, nothing mocked at the
// fs boundary. persistence-write-failure-semantics.test.ts injects ENOSPC and proves what the store does
// with one; this file pins the premise to the kernel: a genuinely full volume produces the code, the
// previous file survives byte-identical, no temp file stays, and recovery publishes.
//
// Opt-in through ORCA_ENOSPC_VOLUME (see real-enospc-volume-test-harness.ts and
// config/scripts/real-enospc-volume.sh). Observations are logged as `REAL_ENOSPC ` lines for the runner.
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultPersistedState } from '../shared/constants'
import { ORCA_PROFILE_INDEX_SCHEMA_VERSION, type OrcaProfileIndex } from '../shared/orca-profiles'
import type { PersistedState } from '../shared/persisted-state-types'
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

describe.skipIf(skipReason !== null)('profile project transfer on a real full filesystem', () => {
  let ballast: string

  beforeEach(() => {
    testState.dir = mkdtempSync(join(volume, 'transfer-'))
    ballast = join(volume, 'transfer-ballast.bin')
    const summary = (id: string, name: string): OrcaProfileIndex['profiles'][number] => ({
      id,
      name,
      avatar: { kind: 'initials', initials: name[0], color: 'neutral' },
      kind: 'local',
      createdAt: 1,
      updatedAt: 1,
      lastOpenedAt: 1
    })
    const index: OrcaProfileIndex = {
      schemaVersion: ORCA_PROFILE_INDEX_SCHEMA_VERSION,
      activeProfileId: 'personal',
      profiles: [summary('personal', 'Personal'), summary('work', 'Work')]
    }
    writeFileSync(join(testState.dir, 'orca-profile-index.json'), JSON.stringify(index), 'utf-8')
    const defaults = getDefaultPersistedState('/Users/tester')
    seedProfile('personal', {
      ...defaults,
      repos: [
        {
          id: 'repo-1',
          path: '/workspace/orca',
          displayName: 'Orca',
          badgeColor: '#33aa99',
          addedAt: 100,
          kind: 'git',
          connectionId: null
        }
      ]
    })
    seedProfile('work', defaults)
  })

  afterEach(() => {
    rmSync(ballast, { force: true })
    rmSync(testState.dir, { recursive: true, force: true })
  })

  function profileDataPath(profileId: string): string {
    return join(testState.dir, 'profiles', profileId, 'orca-data.json')
  }

  function seedProfile(profileId: string, state: PersistedState): void {
    mkdirSync(join(profileDataPath(profileId), '..'), { recursive: true })
    writeFileSync(profileDataPath(profileId), JSON.stringify(state, null, 2), 'utf-8')
  }

  function repoPaths(profileId: string): string[] {
    const parsed = JSON.parse(readFileSync(profileDataPath(profileId), 'utf-8')) as PersistedState
    return parsed.repos.map((repo) => repo.path)
  }

  function profileTempFiles(): string[] {
    return ['personal', 'work'].flatMap((profileId) =>
      readdirSync(join(profileDataPath(profileId), '..')).filter((name) => name.endsWith('.tmp'))
    )
  }

  async function moveProject(): Promise<{ status: string }> {
    const { transferOrcaProfileProject } = await import('./orca-profiles/profile-project-transfer')
    return (await transferOrcaProfileProject(
      { sourceProfileId: 'personal', targetProfileId: 'work', repoId: 'repo-1', mode: 'move' },
      testState.dir
    )) as { status: string }
  }

  it('control: with room a move publishes the project to the target and removes it from the source', async () => {
    const result = await moveProject()

    expect(result.status).toBe('transferred')
    expect(repoPaths('work')).toEqual(['/workspace/orca'])
    expect(repoPaths('personal')).toEqual([])
    expect(profileTempFiles()).toEqual([])
  })

  it('a move onto a full volume rejects with the kernel ENOSPC, never loses the project, leaves no temp file and completes once space is freed', async () => {
    const before = {
      personal: sha256(profileDataPath('personal')),
      work: sha256(profileDataPath('work'))
    }
    const filled = fillRealEnospcVolume(ballast)
    expect(
      filled,
      'nothing was written as ballast; the volume was full before we began'
    ).toBeGreaterThan(0)

    const failure = await moveProject().then(
      () => null,
      (error: NodeJS.ErrnoException) => error
    )

    expect(failure, 'the move on a full volume must reject, not resolve').not.toBeNull()
    expect(failure?.code).toBe('ENOSPC')
    const after = {
      personal: sha256(profileDataPath('personal')),
      work: sha256(profileDataPath('work'))
    }
    observed('profile-transfer-move', failure, before.personal, after.personal)
    console.info(
      `REAL_ENOSPC case=profile-transfer-move-target target_identical=${before.work === after.work} ` +
        `target_holds_project=${repoPaths('work').includes('/workspace/orca')} ` +
        `source_holds_project=${repoPaths('personal').includes('/workspace/orca')}`
    )
    // The source is rewritten only after the target, so a project is never in neither profile.
    expect(after.personal).toBe(before.personal)
    expect(repoPaths('personal')).toEqual(['/workspace/orca'])
    expect(after.work === before.work || repoPaths('work').includes('/workspace/orca')).toBe(true)
    expect(profileTempFiles()).toEqual([])

    rmSync(ballast, { force: true })
    const retried = await moveProject()

    expect(retried.status).toBe('transferred')
    expect(repoPaths('work')).toEqual(['/workspace/orca'])
    expect(repoPaths('personal')).toEqual([])
    expect(profileTempFiles()).toEqual([])
  })
})

if (skipReason !== null) {
  // Say why, every run. A silent skip is indistinguishable from a passing gate.
  console.info(`[real-enospc] persistence skipped: ${skipReason}`)
}
