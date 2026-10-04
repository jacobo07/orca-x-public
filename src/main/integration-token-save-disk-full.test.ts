import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import type * as NodeFs from 'node:fs'
import { tmpdir } from 'node:os'
import type * as NodeOs from 'node:os'
import { basename, join } from 'node:path'

// Why a fs-boundary model rather than a mocked store: the loss this guards is a kernel behaviour.
// open(O_TRUNC) empties the live file BEFORE the write that then fails with ENOSPC, so a writer
// that publishes in place destroys the only working credential. The model keeps that order: a
// writeFileSync into the home truncates first and then fails; a writeSync (the temp-file leg of the
// atomic writer) just fails.
const disk = vi.hoisted(() => ({
  home: '',
  armed: false,
  fired: 0,
  recording: false,
  ordered: [] as string[]
}))

function enospc(syscall: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`ENOSPC: no space left on device, ${syscall}`), {
    code: 'ENOSPC',
    errno: -28,
    syscall
  })
}

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  const inHome = (path: NodeFs.PathLike | number): boolean =>
    typeof path === 'string' && disk.home !== '' && path.startsWith(disk.home)
  const patched = {
    ...actual,
    writeFileSync: (...args: Parameters<typeof NodeFs.writeFileSync>): void => {
      if (disk.armed && inHome(args[0])) {
        actual.closeSync(actual.openSync(args[0] as string, 'w'))
        disk.fired += 1
        throw enospc('write')
      }
      return actual.writeFileSync(...args)
    },
    writeSync: (...args: Parameters<typeof NodeFs.writeSync>): number => {
      if (disk.armed) {
        disk.fired += 1
        throw enospc('write')
      }
      return (actual.writeSync as (...a: unknown[]) => number)(...args)
    },
    fsyncSync: (fd: number): void => {
      if (disk.recording) {
        disk.ordered.push('fsync:file')
      }
      return actual.fsyncSync(fd)
    },
    renameSync: (from: NodeFs.PathLike, to: NodeFs.PathLike): void => {
      if (disk.recording) {
        disk.ordered.push(`rename:${basename(String(to))}`)
      }
      return actual.renameSync(from, to)
    }
  }
  return { ...patched, default: patched }
})

const decryptString = (value: Buffer): string => value.toString('utf-8').replace(/^enc:/, '')

async function loadFreshModules() {
  vi.resetModules()
  vi.doMock('electron', () => ({
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (value: string) => Buffer.from(`enc:${value}`),
      decryptString
    }
  }))
  vi.doMock('node:os', async () => {
    const actual = await vi.importActual<typeof NodeOs>('node:os')
    return { ...actual, homedir: () => disk.home }
  })
  return {
    linear: await import('./linear/linear-token-store'),
    linearPaths: await import('./linear/linear-credential-paths'),
    linearRegistry: await import('./linear/linear-workspace-registry'),
    jira: await import('./jira/site-credential-store'),
    bitbucket: await import('./bitbucket/credential-store')
  }
}

function tempFilesIn(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.tmp')) : []
}

function captureError(run: () => void): NodeJS.ErrnoException {
  try {
    run()
  } catch (error) {
    return error as NodeJS.ErrnoException
  }
  throw new Error('expected the save to throw')
}

beforeEach(() => {
  disk.home = mkdtempSync(join(tmpdir(), 'orca-token-save-disk-full-'))
  mkdirSync(join(disk.home, '.orca'), { recursive: true })
  disk.armed = false
  disk.fired = 0
  disk.recording = false
  disk.ordered.length = 0
})

afterEach(() => {
  disk.armed = false
  disk.recording = false
  rmSync(disk.home, { recursive: true, force: true })
})

describe('integration token re-save on a full disk', () => {
  describe.each([
    ['a workspace token', 'org-123'],
    ['the legacy token', 'legacy']
  ])('Linear %s', (_label, workspaceId) => {
    it('keeps the previous token and reports ENOSPC when the re-save cannot be written', async () => {
      // Arrange
      const { linear, linearPaths } = await loadFreshModules()
      linear.saveWorkspaceToken(workspaceId, 'previous-key')
      const tokenPath = linearPaths.getWorkspaceTokenPath(workspaceId)
      const before = readFileSync(tokenPath)

      // Act
      disk.armed = true
      const error = captureError(() => linear.saveWorkspaceToken(workspaceId, 'replacement-key'))
      disk.armed = false

      // Assert
      expect(disk.fired, 'the injected ENOSPC must actually have fired').toBeGreaterThan(0)
      expect(error.code).toBe('ENOSPC')
      expect(readFileSync(tokenPath)).toEqual(before)
      expect(tempFilesIn(join(tokenPath, '..'))).toEqual([])
      // A failed save must not advance the in-memory token past what the disk holds.
      expect(linear.loadToken({ workspaceId })).toBe('previous-key')
      const fresh = await loadFreshModules()
      expect(fresh.linear.loadToken({ force: true, workspaceId })).toBe('previous-key')
    })

    it('publishes with the file fsynced before the rename when there is room', async () => {
      // Arrange
      const { linear, linearPaths } = await loadFreshModules()
      const tokenPath = linearPaths.getWorkspaceTokenPath(workspaceId)

      // Act
      disk.recording = true
      linear.saveWorkspaceToken(workspaceId, 'first-key')
      disk.recording = false

      // Assert
      // A rename that lands before the fsync can publish a name pointing at an empty inode.
      expect(disk.ordered, `recorded: ${disk.ordered.join(' | ')}`).toEqual([
        'fsync:file',
        `rename:${basename(tokenPath)}`
      ])
      expect(linear.loadToken({ workspaceId })).toBe('first-key')
    })
  })

  describe('Jira site token', () => {
    const siteId = 'https://example.atlassian.net::ada@example.com'

    it('keeps the previous token and reports ENOSPC when the re-save cannot be written', async () => {
      // Arrange
      const { jira } = await loadFreshModules()
      jira.saveToken(siteId, 'previous-token')
      const tokenPath = join(
        disk.home,
        '.orca',
        'jira-tokens',
        `${Buffer.from(siteId).toString('base64url')}.enc`
      )
      const before = readFileSync(tokenPath)

      // Act
      disk.armed = true
      const error = captureError(() => jira.saveToken(siteId, 'replacement-token'))
      disk.armed = false

      // Assert
      expect(disk.fired, 'the injected ENOSPC must actually have fired').toBeGreaterThan(0)
      expect(error.code).toBe('ENOSPC')
      expect(readFileSync(tokenPath)).toEqual(before)
      expect(tempFilesIn(join(tokenPath, '..'))).toEqual([])
      expect(jira.readToken(siteId)).toBe('previous-token')
      const fresh = await loadFreshModules()
      expect(fresh.jira.readToken(siteId)).toBe('previous-token')
    })

    it('publishes with the file fsynced before the rename when there is room', async () => {
      // Arrange
      const { jira } = await loadFreshModules()

      // Act
      disk.recording = true
      jira.saveToken(siteId, 'first-token')
      disk.recording = false

      // Assert
      expect(disk.ordered, `recorded: ${disk.ordered.join(' | ')}`).toEqual([
        'fsync:file',
        `rename:${Buffer.from(siteId).toString('base64url')}.enc`
      ])
      expect(jira.readToken(siteId)).toBe('first-token')
    })
  })

  describe('index files (an empty one reads as "no workspaces" / "no sites")', () => {
    it('keeps the Linear workspace list when a rewrite cannot be written', async () => {
      // Arrange
      const { linear, linearPaths, linearRegistry } = await loadFreshModules()
      linear.saveWorkspaceToken('org-123', 'linear-key')
      const workspace = {
        id: 'org-123',
        organizationId: 'org-123',
        organizationName: 'Acme',
        displayName: 'Ada',
        email: 'ada@example.com'
      }
      linearRegistry.upsertWorkspace(workspace, { select: true })
      const indexPath = linearPaths.getWorkspaceFilePath()
      const before = readFileSync(indexPath)

      // Act
      disk.armed = true
      const error = captureError(() =>
        linearRegistry.upsertWorkspace({ ...workspace, displayName: 'Grace' }, { select: true })
      )
      disk.armed = false

      // Assert
      expect(disk.fired, 'the injected ENOSPC must actually have fired').toBeGreaterThan(0)
      expect(error.code).toBe('ENOSPC')
      expect(readFileSync(indexPath)).toEqual(before)
      expect(tempFilesIn(join(indexPath, '..'))).toEqual([])
      const fresh = await loadFreshModules()
      expect(fresh.linearRegistry.getWorkspaceFile().workspaces).toMatchObject([
        { id: 'org-123', displayName: 'Ada' }
      ])
    })

    it('keeps the Jira site list when a rewrite cannot be written', async () => {
      // Arrange
      const { jira } = await loadFreshModules()
      const site = {
        id: 'site-1',
        siteUrl: 'https://example.atlassian.net',
        email: 'ada@example.com',
        displayName: 'Ada',
        accountId: 'acc-1'
      }
      jira.saveToken(site.id, 'jira-token')
      jira.writeSiteFile({
        version: 1,
        activeSiteId: site.id,
        selectedSiteId: site.id,
        sites: [site]
      })
      const indexPath = join(disk.home, '.orca', 'jira-sites.json')
      const before = readFileSync(indexPath)

      // Act
      disk.armed = true
      const error = captureError(() =>
        jira.writeSiteFile({
          version: 1,
          activeSiteId: site.id,
          selectedSiteId: site.id,
          sites: [{ ...site, displayName: 'Grace' }]
        })
      )
      disk.armed = false

      // Assert
      expect(disk.fired, 'the injected ENOSPC must actually have fired').toBeGreaterThan(0)
      expect(error.code).toBe('ENOSPC')
      expect(readFileSync(indexPath)).toEqual(before)
      expect(tempFilesIn(join(indexPath, '..'))).toEqual([])
      const fresh = await loadFreshModules()
      expect(fresh.jira.getSiteFile().sites).toMatchObject([{ id: 'site-1', displayName: 'Ada' }])
    })
  })

  describe('Bitbucket secret (control: already atomic)', () => {
    it('keeps the previous secret and reports ENOSPC when the re-save cannot be written', async () => {
      // Arrange
      const { bitbucket } = await loadFreshModules()
      const save = (apiToken: string): void =>
        bitbucket.saveBitbucketCredential({
          authMode: 'basic',
          email: 'ada@example.com',
          baseUrl: null,
          account: 'ada',
          accessToken: null,
          apiToken
        })
      save('previous-secret')
      const secretPath = join(disk.home, '.orca', 'bitbucket-credential.enc')
      const before = readFileSync(secretPath)

      // Act
      disk.armed = true
      const error = captureError(() => save('replacement-secret'))
      disk.armed = false

      // Assert
      expect(disk.fired, 'the injected ENOSPC must actually have fired').toBeGreaterThan(0)
      expect(error.code).toBe('ENOSPC')
      expect(readFileSync(secretPath)).toEqual(before)
      expect(tempFilesIn(join(disk.home, '.orca'))).toEqual([])
      const fresh = await loadFreshModules()
      expect(fresh.bitbucket.loadStoredBitbucketSecret({ force: true })).toMatchObject({
        apiToken: 'previous-secret'
      })
    })
  })
})
