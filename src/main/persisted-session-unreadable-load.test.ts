import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createStore, dataFile, testState } from './persistence-test-harness'

// Why: red controls for the corpus gate. Every control is derived at test time from a COPY of a corpus fixture
// (truncated or edited in the temp userData dir); the committed fixtures are never touched.
vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => {
      const decoded = ciphertext.toString('utf-8')
      if (!decoded.startsWith('encrypted:')) {
        throw new Error('invalid ciphertext')
      }
      return decoded.slice('encrypted:'.length)
    }
  }
}))

vi.mock('./ssh/ssh-config-parser', () => ({
  loadUserSshConfig: () => [],
  sshConfigHostsToTargets: () => []
}))

const CORPUS_DIR = fileURLToPath(
  new URL('../../tests/fixtures/persisted-sessions', import.meta.url)
)
const PRIMARY_ERA = 'main-49b1415e7'
const BACKUP_ERA = 'pre-5234-36e439907'
const QUARANTINE_PREFIX = 'orca-data.json.unreadable-'

function fixtureBytes(era: string): Buffer {
  return readFileSync(join(CORPUS_DIR, era, 'orca-data.json'))
}

function fixtureExpectedRepos(era: string): string[] {
  const provenance = JSON.parse(
    readFileSync(join(CORPUS_DIR, era, 'provenance.json'), 'utf-8')
  ) as {
    expected: { repos: string[] }
  }
  return provenance.expected.repos
}

function truncatedPrimary(era: string, keepFraction = 0.5): Buffer {
  const bytes = fixtureBytes(era)
  return bytes.subarray(0, Math.floor(bytes.length * keepFraction))
}

function writePrimary(bytes: Buffer): void {
  mkdirSync(testState.dir, { recursive: true })
  writeFileSync(dataFile(), bytes)
}

function quarantineFiles(): string[] {
  return readdirSync(testState.dir)
    .filter((name) => name.startsWith(QUARANTINE_PREFIX))
    .sort()
}

function readQuarantine(name: string): Buffer {
  return readFileSync(join(testState.dir, name))
}

function repoKeys(store: Awaited<ReturnType<typeof createStore>>): string[] {
  return store
    .getRepos()
    .map((r) => `${r.id}|${r.path}|${r.displayName}`)
    .sort()
}

describe('persisted-session unreadable-load red controls', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-unreadable-'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('quarantines a truncated primary byte-identical and names it when no backup exists', async () => {
    // Arrange
    const original = truncatedPrimary(PRIMARY_ERA)
    writePrimary(original)

    // Act
    const store = await createStore()

    // Assert
    const quarantined = quarantineFiles()
    expect(quarantined).toHaveLength(1)
    expect(readQuarantine(quarantined[0]).equals(original)).toBe(true)
    expect(store.getRepos()).toEqual([])
    expect(store.getStartupLoadOutcome()).toEqual({
      kind: 'unreadable-defaulted',
      quarantinePath: join(testState.dir, quarantined[0])
    })
  })

  it('keeps the quarantine byte-identical after the first save over the unreadable primary', async () => {
    // Arrange
    const original = truncatedPrimary(PRIMARY_ERA)
    writePrimary(original)
    const store = await createStore()

    // Act
    store.flush()

    // Assert: the primary was replaced by defaults, the unreadable bytes live on in the quarantine
    expect(readFileSync(dataFile()).equals(original)).toBe(false)
    const quarantined = quarantineFiles()
    expect(quarantined).toHaveLength(1)
    expect(readQuarantine(quarantined[0]).equals(original)).toBe(true)
  })

  it('quarantines the unreadable primary before restoring a parseable backup and names the slot', async () => {
    // Arrange
    const original = truncatedPrimary(PRIMARY_ERA)
    writePrimary(original)
    copyFileSync(join(CORPUS_DIR, BACKUP_ERA, 'orca-data.json'), `${dataFile()}.bak.0`)

    // Act
    const store = await createStore()

    // Assert
    const quarantined = quarantineFiles()
    expect(quarantined).toHaveLength(1)
    expect(readQuarantine(quarantined[0]).equals(original)).toBe(true)
    expect(repoKeys(store)).toEqual(fixtureExpectedRepos(BACKUP_ERA))
    expect(store.getStartupLoadOutcome()).toEqual({
      kind: 'recovered-from-backup',
      slot: 0,
      quarantinePath: join(testState.dir, quarantined[0]),
      quarantineFailureCode: null
    })
  })

  it('reports absent and writes no quarantine on a fresh install', async () => {
    // Act
    const store = await createStore()

    // Assert
    expect(store.getStartupLoadOutcome()).toEqual({ kind: 'absent' })
    expect(quarantineFiles()).toEqual([])
  })

  it('reports loaded and writes no quarantine for a readable fixture', async () => {
    // Arrange
    writePrimary(fixtureBytes(PRIMARY_ERA))

    // Act
    const store = await createStore()

    // Assert
    expect(repoKeys(store)).toEqual(fixtureExpectedRepos(PRIMARY_ERA))
    expect(store.getStartupLoadOutcome()).toEqual({ kind: 'loaded' })
    expect(quarantineFiles()).toEqual([])
  })

  it('never overwrites an earlier quarantine when a second unreadable load lands on the same stamp', async () => {
    // Arrange: a frozen clock makes both loads derive the identical quarantine stamp
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-04T08:00:00Z'))
    const first = truncatedPrimary(PRIMARY_ERA, 0.4)
    const second = truncatedPrimary(BACKUP_ERA, 0.6)
    writePrimary(first)
    await createStore()
    const [firstName] = quarantineFiles()

    // Act
    writePrimary(second)
    const store = await createStore()

    // Assert
    const quarantined = quarantineFiles()
    expect(quarantined).toHaveLength(2)
    expect(readQuarantine(firstName).equals(first)).toBe(true)
    const secondName = quarantined.find((name) => name !== firstName) as string
    expect(readQuarantine(secondName).equals(second)).toBe(true)
    expect(store.getStartupLoadOutcome()).toEqual({
      kind: 'unreadable-defaulted',
      quarantinePath: join(testState.dir, secondName)
    })
  })

  it('reports unreadable-unquarantined with the OS code and still defaults when the primary cannot be read', async () => {
    // Arrange: a directory where the file belongs makes the read, and so the quarantine copy, fail with EISDIR
    mkdirSync(dataFile(), { recursive: true })

    // Act
    const store = await createStore()

    // Assert: no new crash path, the load carries on exactly as before
    expect(store.getRepos()).toEqual([])
    expect(store.getStartupLoadOutcome()).toEqual({
      kind: 'unreadable-unquarantined',
      code: 'EISDIR'
    })
    expect(quarantineFiles()).toEqual([])
  })

  it('reports backups-unusable-defaulted and quarantines nothing when no primary exists and no backup parses', async () => {
    // Arrange: only a garbage backup slot, so there is no primary whose bytes could be lost
    mkdirSync(testState.dir, { recursive: true })
    writeFileSync(`${dataFile()}.bak.0`, '{"truncated"')

    // Act
    const store = await createStore()

    // Assert
    expect(store.getRepos()).toEqual([])
    expect(store.getStartupLoadOutcome()).toEqual({ kind: 'backups-unusable-defaulted' })
    expect(quarantineFiles()).toEqual([])
  })

  it('salvages a session with one corrupt tab entry, names the drop and keeps the sibling tabs', async () => {
    // Arrange: the same valid fixture with one extra tab entry that cannot validate
    const profile = JSON.parse(fixtureBytes(PRIMARY_ERA).toString('utf-8')) as {
      workspaceSession: { tabsByWorktree: Record<string, { id: string }[]> }
    }
    const worktreeId = Object.keys(profile.workspaceSession.tabsByWorktree)[0]
    const siblingIds = profile.workspaceSession.tabsByWorktree[worktreeId].map((tab) => tab.id)
    profile.workspaceSession.tabsByWorktree[worktreeId].push({ id: 'tab-corrupt-entry' })
    writePrimary(Buffer.from(JSON.stringify(profile)))

    // Act
    const store = await createStore()

    // Assert
    const keptIds = (store.getWorkspaceSession().tabsByWorktree[worktreeId] ?? []).map((t) => t.id)
    expect(keptIds).toEqual(siblingIds)
    expect(console.warn).toHaveBeenCalledWith(
      '[persistence] Salvaged workspace session; dropped corrupt entries:',
      { count: 1, fields: ['tabsByWorktree'], detailsTruncated: false }
    )
    expect(store.getStartupLoadOutcome()).toEqual({ kind: 'loaded' })
    expect(quarantineFiles()).toEqual([])
  })

  it('loads a profile with unknown extra top-level and session fields without losing known content', async () => {
    // Arrange: fields a newer writer might add
    const profile = JSON.parse(fixtureBytes(PRIMARY_ERA).toString('utf-8')) as Record<
      string,
      unknown
    > & { workspaceSession: Record<string, unknown> }
    profile.fromTheFutureTopLevel = { a: 1 }
    profile.workspaceSession.fromTheFutureField = [1, 2]
    writePrimary(Buffer.from(JSON.stringify(profile)))

    // Act
    const store = await createStore()
    store.flush()

    // Assert: known content survives and the load is a plain load
    expect(repoKeys(store)).toEqual(fixtureExpectedRepos(PRIMARY_ERA))
    expect(Object.values(store.getWorkspaceSession().tabsByWorktree).flat()).toHaveLength(3)
    expect(store.getStartupLoadOutcome()).toEqual({ kind: 'loaded' })
    // Observation only (no assertion): whether the loader's own save keeps what it does not know
    const saved = readFileSync(dataFile(), 'utf-8')
    process.stdout.write(
      `UNKNOWN_FIELD_ON_SAVE top=${saved.includes('fromTheFutureTopLevel') ? 'kept' : 'dropped'} session=${saved.includes('fromTheFutureField') ? 'kept' : 'dropped'}\n`
    )
  })

  describe('a valid-JSON profile whose session part fails validation', () => {
    const CORRUPT_HOST = 'ssh:corrupt-host'
    const VALID_HOST = 'ssh:valid-host'
    // Why: a local mirror of the quarantine module's name-search bound, so the RED run fails on bytes and outcome, never on an import.
    const QUARANTINE_NAME_ATTEMPTS = 1000

    type Profile = Record<string, unknown> & {
      workspaceSession: { tabsByWorktree: Record<string, { id: string }[]> }
    }

    function corruptProfile(
      mutate: (profile: Profile) => void,
      era: string = PRIMARY_ERA
    ): { bytes: Buffer; profile: Profile } {
      const profile = JSON.parse(fixtureBytes(era).toString('utf-8')) as Profile
      mutate(profile)
      const bytes = Buffer.from(JSON.stringify(profile))
      writePrimary(bytes)
      return { bytes, profile }
    }

    it('quarantines the original bytes and names it when the whole workspace session fails validation', async () => {
      // Arrange
      const { bytes } = corruptProfile((profile) => {
        profile.workspaceSession = 'not-a-session' as never
      })

      // Act
      const store = await createStore()

      // Assert
      expect(console.error).toHaveBeenCalledWith(
        '[persistence] Corrupt workspace session, using defaults:',
        expect.anything()
      )
      const quarantined = quarantineFiles()
      expect(quarantined).toHaveLength(1)
      expect(readQuarantine(quarantined[0]).equals(bytes)).toBe(true)
      expect(repoKeys(store)).toEqual(fixtureExpectedRepos(PRIMARY_ERA))
      expect(Object.values(store.getWorkspaceSession().tabsByWorktree ?? {}).flat()).toHaveLength(0)
      expect(store.getStartupLoadOutcome()).toEqual({
        kind: 'session-unreadable-defaulted',
        quarantinePath: join(testState.dir, quarantined[0]),
        defaulted: ['workspaceSession']
      })
    })

    it('keeps the session quarantine byte-identical and the rest of the profile after the first save', async () => {
      // Arrange
      const { bytes } = corruptProfile((profile) => {
        profile.workspaceSession = 'not-a-session' as never
      })
      const store = await createStore()

      // Act
      store.flush()

      // Assert
      const bak0 = `${dataFile()}.bak.0`
      let bak0State = 'absent'
      try {
        bak0State = readFileSync(bak0).equals(bytes) ? 'kept' : 'absent'
      } catch {
        // Observation only: no backup slot was written.
      }
      process.stdout.write(`SESSION_BYTES_IN_BAK0 ${bak0State}\n`)
      expect(readFileSync(dataFile()).equals(bytes)).toBe(false)
      const quarantined = quarantineFiles()
      expect(quarantined).toHaveLength(1)
      expect(readQuarantine(quarantined[0]).equals(bytes)).toBe(true)
      const reloaded = await createStore()
      expect(repoKeys(reloaded)).toEqual(fixtureExpectedRepos(PRIMARY_ERA))
      expect(reloaded.getStartupLoadOutcome()).toEqual({ kind: 'loaded' })
      expect(quarantineFiles()).toEqual(quarantined)
    })

    it('reports session-unreadable-unquarantined with the code and still loads the rest when no quarantine name is free', async () => {
      // Arrange: a frozen clock makes every candidate name predictable, and each one is taken
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date('2026-10-04T08:00:00Z'))
      corruptProfile((profile) => {
        profile.workspaceSession = 'not-a-session' as never
      })
      const base = `${dataFile()}.unreadable-20261004T080000Z`
      const taken: string[] = []
      for (let attempt = 0; attempt < QUARANTINE_NAME_ATTEMPTS; attempt++) {
        const path = attempt === 0 ? base : `${base}-${attempt}`
        writeFileSync(path, '')
        taken.push(path)
      }
      const before = quarantineFiles()

      // Act
      const store = await createStore()

      // Assert
      expect(repoKeys(store)).toEqual(fixtureExpectedRepos(PRIMARY_ERA))
      expect(store.getStartupLoadOutcome()).toEqual({
        kind: 'session-unreadable-unquarantined',
        code: 'EEXIST',
        defaulted: ['workspaceSession']
      })
      expect(quarantineFiles()).toEqual(before)
      expect(taken.every((path) => readFileSync(path).length === 0)).toBe(true)
    })

    it('quarantines a corrupt per-host session partition and keeps the valid sibling partition', async () => {
      // Arrange
      const { bytes, profile } = corruptProfile((p) => {
        p.workspaceSessionsByHostId = {
          [VALID_HOST]: JSON.parse(JSON.stringify(p.workspaceSession)),
          [CORRUPT_HOST]: 'not-a-session'
        }
      })
      const validTabIds = Object.values(profile.workspaceSession.tabsByWorktree)
        .flat()
        .map((tab) => tab.id)

      // Act
      const store = await createStore()

      // Assert
      expect(console.error).toHaveBeenCalledWith(
        `[persistence] Corrupt workspace session for host ${CORRUPT_HOST}, using defaults:`,
        expect.anything()
      )
      const keptTabIds = Object.values(store.getWorkspaceSession(VALID_HOST).tabsByWorktree ?? {})
        .flat()
        .map((tab) => tab.id)
      expect(keptTabIds).toEqual(validTabIds)
      expect(store.getWorkspaceSessionHostIds()).not.toContain(CORRUPT_HOST)
      const quarantined = quarantineFiles()
      expect(quarantined).toHaveLength(1)
      expect(readQuarantine(quarantined[0]).equals(bytes)).toBe(true)
      expect(store.getStartupLoadOutcome()).toEqual({
        kind: 'session-unreadable-defaulted',
        quarantinePath: join(testState.dir, quarantined[0]),
        defaulted: [`workspaceSessionsByHostId.${CORRUPT_HOST}`]
      })
      store.flush()
      expect(readQuarantine(quarantined[0]).equals(bytes)).toBe(true)
      const saved = JSON.parse(readFileSync(dataFile(), 'utf-8')) as {
        workspaceSessionsByHostId: Record<string, unknown>
      }
      expect(Object.keys(saved.workspaceSessionsByHostId)).toEqual([VALID_HOST])
    })

    it('writes one quarantine per load that covers a corrupt session and a corrupt partition together', async () => {
      // Arrange
      const { bytes } = corruptProfile((profile) => {
        profile.workspaceSession = 'not-a-session' as never
        profile.workspaceSessionsByHostId = { [CORRUPT_HOST]: 'not-a-session' }
      })

      // Act
      const store = await createStore()

      // Assert: the single copy of the whole file holds both corrupt parts
      const quarantined = quarantineFiles()
      expect(quarantined).toHaveLength(1)
      expect(readQuarantine(quarantined[0]).equals(bytes)).toBe(true)
      expect(store.getStartupLoadOutcome()).toEqual({
        kind: 'session-unreadable-defaulted',
        quarantinePath: join(testState.dir, quarantined[0]),
        defaulted: ['workspaceSession', `workspaceSessionsByHostId.${CORRUPT_HOST}`]
      })
    })

    it('quarantines the per-host session map when it is not an object', async () => {
      // Arrange
      const { bytes } = corruptProfile((profile) => {
        profile.workspaceSessionsByHostId = 'not-a-map'
      })

      // Act
      const store = await createStore()

      // Assert
      const quarantined = quarantineFiles()
      expect(quarantined).toHaveLength(1)
      expect(readQuarantine(quarantined[0]).equals(bytes)).toBe(true)
      expect(repoKeys(store)).toEqual(fixtureExpectedRepos(PRIMARY_ERA))
      expect(Object.values(store.getWorkspaceSession().tabsByWorktree ?? {}).flat()).toHaveLength(3)
      expect(store.getStartupLoadOutcome()).toEqual({
        kind: 'session-unreadable-defaulted',
        quarantinePath: join(testState.dir, quarantined[0]),
        defaulted: ['workspaceSessionsByHostId']
      })
    })
  })
})
