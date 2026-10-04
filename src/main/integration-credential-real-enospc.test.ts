// The Linear token and the Bitbucket secret on a real full filesystem, nothing mocked at the fs boundary.
// integration-token-save-disk-full.test.ts models ENOSPC at the fs boundary; this file pins the premise to
// the kernel: a genuinely full volume makes the re-save throw the code, the previous bytes survive, no temp
// file stays, and the save publishes once space is freed.
//
// Opt-in through ORCA_ENOSPC_VOLUME (see real-enospc-volume-test-harness.ts and
// config/scripts/real-enospc-volume.sh). Observations are logged as `REAL_ENOSPC ` lines for the runner.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import type * as NodeOs from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  fillRealEnospcVolume,
  realEnospcVolume,
  realEnospcVolumeUnusableReason
} from './real-enospc-volume-test-harness'

const volume = realEnospcVolume()
const skipReason = realEnospcVolumeUnusableReason()

const state = { home: '' }
const PREVIOUS = 'synthetic-previous-value'
const REPLACEMENT = 'synthetic-replacement-value'
const WORKSPACE = 'org-123'

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

async function loadFreshModules() {
  vi.resetModules()
  vi.doMock('electron', () => ({
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (value: string) => Buffer.from(`enc:${value}`),
      decryptString: (value: Buffer) => value.toString('utf-8').replace(/^enc:/, '')
    }
  }))
  vi.doMock('node:os', async () => {
    const actual = await vi.importActual<typeof NodeOs>('node:os')
    return { ...actual, homedir: () => state.home }
  })
  return {
    linear: await import('./linear/linear-token-store'),
    linearPaths: await import('./linear/linear-credential-paths'),
    bitbucket: await import('./bitbucket/credential-store')
  }
}

function tempFilesIn(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.tmp')) : []
}

function captureError(run: () => void): NodeJS.ErrnoException | null {
  try {
    run()
  } catch (error) {
    return error as NodeJS.ErrnoException
  }
  return null
}

/** The observed failure, as the runner greps it: which code, from which syscall, at which stage. */
function observed(label: string, error: NodeJS.ErrnoException | null, identical: boolean): void {
  console.info(
    `REAL_ENOSPC case=${label} code=${error?.code ?? 'none'} syscall=${error?.syscall ?? 'none'} ` +
      `stage=${(error as { stage?: string } | null)?.stage ?? 'none'} error=${error?.name ?? 'none'} ` +
      `identical=${identical}`
  )
}

describe.skipIf(skipReason !== null)('credential saves on a real full filesystem', () => {
  let ballast: string

  beforeEach(() => {
    state.home = mkdtempSync(join(volume, 'credentials-'))
    mkdirSync(join(state.home, '.orca'), { recursive: true })
    ballast = join(volume, 'credentials-ballast.bin')
  })

  afterEach(() => {
    vi.doUnmock('node:os')
    vi.doUnmock('electron')
    rmSync(ballast, { force: true })
    rmSync(state.home, { recursive: true, force: true })
  })

  function fillOrFail(): void {
    expect(
      fillRealEnospcVolume(ballast),
      'nothing was written as ballast; the volume was full before we began'
    ).toBeGreaterThan(0)
  }

  it('Linear token: a re-save on a full volume throws ENOSPC, keeps the previous value and publishes once space is freed', async () => {
    // Arrange
    const { linear, linearPaths } = await loadFreshModules()
    linear.saveWorkspaceToken(WORKSPACE, PREVIOUS)
    const tokenPath = linearPaths.getWorkspaceTokenPath(WORKSPACE)
    const before = sha256(tokenPath)

    // Act
    fillOrFail()
    const error = captureError(() => linear.saveWorkspaceToken(WORKSPACE, REPLACEMENT))

    // Assert
    expect(error, 'the re-save on a full volume must throw').not.toBeNull()
    expect(error?.code).toBe('ENOSPC')
    const after = sha256(tokenPath)
    observed('linear-token-resave', error, after === before)
    expect(after).toBe(before)
    expect(tempFilesIn(join(tokenPath, '..'))).toEqual([])
    // A failed save must not advance the in-memory value past what the disk holds.
    expect(linear.loadToken({ workspaceId: WORKSPACE })).toBe(PREVIOUS)
    const fresh = await loadFreshModules()
    expect(fresh.linear.loadToken({ force: true, workspaceId: WORKSPACE })).toBe(PREVIOUS)

    rmSync(ballast, { force: true })
    linear.saveWorkspaceToken(WORKSPACE, REPLACEMENT)

    expect(sha256(tokenPath)).not.toBe(before)
    expect(tempFilesIn(join(tokenPath, '..'))).toEqual([])
    const afterRecovery = await loadFreshModules()
    expect(afterRecovery.linear.loadToken({ force: true, workspaceId: WORKSPACE })).toBe(
      REPLACEMENT
    )
  })

  it('Linear token: control, with room the re-save publishes the replacement', async () => {
    const { linear, linearPaths } = await loadFreshModules()
    linear.saveWorkspaceToken(WORKSPACE, PREVIOUS)

    linear.saveWorkspaceToken(WORKSPACE, REPLACEMENT)

    expect(tempFilesIn(join(linearPaths.getWorkspaceTokenPath(WORKSPACE), '..'))).toEqual([])
    const fresh = await loadFreshModules()
    expect(fresh.linear.loadToken({ force: true, workspaceId: WORKSPACE })).toBe(REPLACEMENT)
  })

  it('Bitbucket secret: a re-save on a full volume throws ENOSPC, keeps the previous secret and metadata and publishes once space is freed', async () => {
    // Arrange
    const { bitbucket } = await loadFreshModules()
    const save = (value: string): void =>
      bitbucket.saveBitbucketCredential({
        authMode: 'basic',
        email: 'ada@example.com',
        baseUrl: null,
        account: 'ada',
        accessToken: null,
        apiToken: value
      })
    save(PREVIOUS)
    const secretPath = join(state.home, '.orca', 'bitbucket-credential.enc')
    const metadataPath = join(state.home, '.orca', 'bitbucket-credential.json')
    const before = { secret: sha256(secretPath), metadata: sha256(metadataPath) }

    // Act
    fillOrFail()
    const error = captureError(() => save(REPLACEMENT))

    // Assert
    expect(error, 'the re-save on a full volume must throw').not.toBeNull()
    expect(error?.code).toBe('ENOSPC')
    const after = { secret: sha256(secretPath), metadata: sha256(metadataPath) }
    observed('bitbucket-secret-resave', error, after.secret === before.secret)
    expect(after).toEqual(before)
    expect(tempFilesIn(join(state.home, '.orca'))).toEqual([])
    const fresh = await loadFreshModules()
    expect(fresh.bitbucket.loadStoredBitbucketSecret({ force: true })).toMatchObject({
      apiToken: PREVIOUS
    })

    rmSync(ballast, { force: true })
    save(REPLACEMENT)

    expect(tempFilesIn(join(state.home, '.orca'))).toEqual([])
    const afterRecovery = await loadFreshModules()
    expect(afterRecovery.bitbucket.loadStoredBitbucketSecret({ force: true })).toMatchObject({
      apiToken: REPLACEMENT
    })
  })
})

if (skipReason !== null) {
  // Say why, every run. A silent skip is indistinguishable from a passing gate.
  console.info(`[real-enospc] credentials skipped: ${skipReason}`)
}
