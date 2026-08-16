import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import type * as NodeFsPromises from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const testState = { dir: '' }

const fsCalls = vi.hoisted(() => {
  const calls = {
    recording: false,
    dirPrefix: '',
    failAsync: null as ((fn: string, target: string) => NodeJS.ErrnoException | null) | null,
    reset(): void {
      calls.failAsync = null
    },
    recordAsync(fn: string, target: unknown): NodeJS.ErrnoException | null {
      if (
        !calls.recording ||
        typeof target !== 'string' ||
        calls.dirPrefix === '' ||
        !target.startsWith(calls.dirPrefix)
      ) {
        return null
      }
      return calls.failAsync?.(fn, target) ?? null
    }
  }
  return calls
})

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFsPromises>()
  const patched: Record<string, unknown> = { ...actual }
  for (const name of ['stat', 'access', 'rename', 'copyFile', 'rm', 'mkdir', 'open']) {
    const fn = (actual as unknown as Record<string, (...args: unknown[]) => unknown>)[name]
    patched[name] = async (...args: unknown[]): Promise<unknown> => {
      const failure = fsCalls.recordAsync(name, args[0])
      if (failure) {
        throw failure
      }
      return fn(...args)
    }
  }
  return { ...patched, default: patched }
})

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

const BACKUP_COUNT = 5
const BACKUP_MIN_INTERVAL_MS = 60 * 60 * 1000
const SAVE_DEBOUNCE_MS = 1_000

type TestStore = {
  updateUI(updates: { sidebarWidth: number }): void
  waitForPendingWrite(): Promise<void>
}

function dataFile(dir: string): string {
  return join(dir, 'orca-data.json')
}

function backupSlots(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.startsWith('orca-data.json.bak.'))
    .sort()
}

/** Fill every ring slot and age slot 0 past the throttle so the first rotation is legitimately due. */
function seedSaturatedRing(dir: string): string[] {
  const contents: string[] = []
  for (let i = 0; i < BACKUP_COUNT; i++) {
    const body = `{"seeded":${i}}`
    contents.push(body)
    writeFileSync(`${dataFile(dir)}.bak.${i}`, body, 'utf-8')
  }
  const staleSeconds = (Date.now() - BACKUP_MIN_INTERVAL_MS * 2) / 1000
  utimesSync(`${dataFile(dir)}.bak.0`, staleSeconds, staleSeconds)
  return contents
}

describe('backup ring survives a failing snapshot leg', () => {
  const dirs: string[] = []

  beforeEach(() => {
    fsCalls.recording = false
    fsCalls.dirPrefix = ''
    fsCalls.reset()
    vi.useFakeTimers()
  })

  afterEach(() => {
    fsCalls.recording = false
    vi.useRealTimers()
    while (dirs.length > 0) {
      rmSync(dirs.pop() as string, { recursive: true, force: true })
    }
  })

  async function createStore(dir: string): Promise<TestStore> {
    testState.dir = dir
    vi.resetModules()
    const { Store, initDataPath } = await import('./persistence')
    initDataPath()
    return new Store() as unknown as TestStore
  }

  it('keeps earlier slots when the .bak.0 snapshot copy keeps failing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-ring-drain-'))
    dirs.push(dir)
    const store = await createStore(dir)
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const seeded = seedSaturatedRing(dir)

    // A profile dir under AV/indexer lock or a degraded mount rejects the copy while every other
    // syscall keeps working -- the ring's own hazard, not the primary write's.
    fsCalls.dirPrefix = dir
    fsCalls.recording = true
    fsCalls.failAsync = (fn, target) =>
      fn === 'copyFile' && target === dataFile(dir)
        ? Object.assign(new Error('profile dir locked'), { code: 'EPERM' })
        : null

    try {
      // Only the debounce advances: after the first due rotation the throttle must hold the rest.
      for (let i = 0; i < BACKUP_COUNT + 1; i++) {
        store.updateUI({ sidebarWidth: 400 + i })
        vi.advanceTimersByTime(SAVE_DEBOUNCE_MS)
        await store.waitForPendingWrite()
      }
    } finally {
      fsCalls.recording = false
      fsCalls.failAsync = null
      errors.mockRestore()
    }

    const remaining = backupSlots(dir)
    // Losing the newest snapshot is acceptable; consuming the surviving ring is not. A missing
    // .bak.0 disables the interval throttle, so every later save evicts one more good slot.
    expect(
      remaining.length,
      `ring drained to ${remaining.length} slots in ${BACKUP_COUNT + 1} saves`
    ).toBeGreaterThan(0)

    const survivingBodies = remaining.map((name) => readFileSync(join(dir, name), 'utf-8'))
    expect(
      survivingBodies.some((body) => seeded.includes(body)),
      'no seeded backup survived the failing snapshot leg'
    ).toBe(true)
  })
})
