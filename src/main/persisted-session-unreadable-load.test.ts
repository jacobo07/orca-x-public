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
})
