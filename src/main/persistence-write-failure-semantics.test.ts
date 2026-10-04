// What a full disk costs the profile data file (persistence.profile-data-file). Every case plants
// ENOSPC after part of the payload has already reached the temp file, then reads the outcome from
// disk: a thrown error is not evidence the previous file survived, and an injector that never fires
// leaves the happy path running, so each case proves the fault actually ran before judging.
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import type * as NodeFs from 'node:fs'
import type * as NodeFsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DurablePublishError } from './durable-file-write'
import {
  createStore,
  dataFile,
  makeRepo,
  readDataFile,
  testState
} from './persistence-test-harness'

const fault = vi.hoisted(() => {
  const state = {
    armed: false,
    fired: 0,
    /** Only a temp sibling of this file is faulted; every other write in the directory is untouched. */
    targetPrefix: '',
    reset(): void {
      state.armed = false
      state.fired = 0
      state.targetPrefix = ''
    },
    matches(path: unknown): boolean {
      return (
        state.armed &&
        typeof path === 'string' &&
        state.targetPrefix !== '' &&
        path.startsWith(`${state.targetPrefix}.`) &&
        path.endsWith('.tmp')
      )
    },
    /** Shaped like the real thing: GEX44 measured `code=ENOSPC syscall=write` on a full ext4 loop. */
    raise(): never {
      state.fired += 1
      const error = new Error('ENOSPC: no space left on device, write') as NodeJS.ErrnoException
      error.code = 'ENOSPC'
      error.syscall = 'write'
      error.errno = -28
      throw error
    }
  }
  return state
})

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFsPromises>()
  const patched: Record<string, unknown> = { ...(actual as unknown as Record<string, unknown>) }
  patched.open = async (...args: Parameters<typeof actual.open>): Promise<unknown> => {
    const handle = await actual.open(...args)
    const path = args[0]
    return new Proxy(handle, {
      get(base, prop) {
        if (prop === 'writeFile') {
          return async (payload: string, ...rest: unknown[]): Promise<void> => {
            if (fault.matches(path)) {
              // Why part of the payload lands first: a full disk truncates mid-write, which is the
              // state the temp-file cleanup and the untouched primary file exist to survive.
              await base.writeFile(payload.slice(0, Math.floor(payload.length / 2)), 'utf-8')
              fault.raise()
            }
            await (base.writeFile as (...a: unknown[]) => Promise<void>)(payload, ...rest)
          }
        }
        const value = Reflect.get(base, prop, base)
        return typeof value === 'function' ? value.bind(base) : value
      }
    })
  }
  return { ...patched, default: patched }
})

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  const patched = {
    ...actual,
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>): void => {
      if (fault.matches(args[0])) {
        actual.writeFileSync(
          args[0],
          String(args[1]).slice(0, Math.floor(String(args[1]).length / 2))
        )
        fault.raise()
      }
      actual.writeFileSync(...args)
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

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function tempSiblings(): string[] {
  return readdirSync(testState.dir).filter((name) => name.endsWith('.tmp'))
}

function publishedRepoIds(): string[] {
  return (readDataFile() as { repos: { id: string }[] }).repos.map((repo) => repo.id)
}

describe('profile data file when the disk is full', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-profile-enospc-'))
    fault.reset()
    fault.targetPrefix = join(testState.dir, 'orca-data.json')
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
    fault.reset()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  async function storeWithPublishedRepo(): Promise<{
    store: Awaited<ReturnType<typeof createStore>>
    publishedHash: string
  }> {
    const store = await createStore()
    store.addRepo(makeRepo({ id: 'published' }))
    await store.flushPendingOrThrowAsync()
    expect(fault.fired, 'the injector must not fire while the disk has room').toBe(0)
    expect(publishedRepoIds()).toEqual(['published'])
    store.addRepo(makeRepo({ id: 'pending', path: '/repo-pending' }))
    return { store, publishedHash: sha256(dataFile()) }
  }

  it('control: with space available the pending repo is published', async () => {
    const { store } = await storeWithPublishedRepo()

    await store.flushPendingOrThrowAsync()

    expect(publishedRepoIds()).toEqual(['published', 'pending'])
    expect(fault.fired).toBe(0)
  })

  it('async flush rejects with ENOSPC, keeps the previous file byte-identical and leaves no temp file', async () => {
    const { store, publishedHash } = await storeWithPublishedRepo()
    fault.armed = true

    const failure = await store.flushPendingOrThrowAsync().then(
      () => null,
      (error: NodeJS.ErrnoException) => error
    )

    expect(fault.fired, 'the injector must have run').toBeGreaterThan(0)
    expect(failure?.code).toBe('ENOSPC')
    expect(sha256(dataFile())).toBe(publishedHash)
    expect(tempSiblings()).toEqual([])
  })

  it('a failed async write is not marked as written: the next flush after the disk recovers publishes it', async () => {
    const { store } = await storeWithPublishedRepo()
    fault.armed = true
    await store.flushPendingOrThrowAsync().catch(() => {})
    expect(fault.fired).toBeGreaterThan(0)
    fault.armed = false

    await store.flushPendingAsync()

    expect(publishedRepoIds()).toEqual(['published', 'pending'])
    const reloaded = await createStore()
    expect(reloaded.getRepos().map((repo) => repo.id)).toEqual(['published', 'pending'])
  })

  it('sync flush throws a DurablePublishError carrying ENOSPC, keeps the previous file and recovers', async () => {
    const { store, publishedHash } = await storeWithPublishedRepo()
    fault.armed = true

    let failure: unknown = null
    try {
      store.flushOrThrow()
    } catch (error) {
      failure = error
    }

    expect(fault.fired, 'the injector must have run').toBeGreaterThan(0)
    // Why by name: createStore resets the module registry, so the class identity differs.
    expect((failure as Error).name).toBe('DurablePublishError')
    expect((failure as DurablePublishError).code).toBe('ENOSPC')
    expect((failure as DurablePublishError).stage).toBe('write')
    expect(sha256(dataFile())).toBe(publishedHash)
    expect(tempSiblings()).toEqual([])
    fault.armed = false

    store.flushOrThrow()

    expect(publishedRepoIds()).toEqual(['published', 'pending'])
  })

  it('flush() reports nothing to its caller but logs, and keeps the previous file', async () => {
    const { store, publishedHash } = await storeWithPublishedRepo()
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    fault.armed = true

    expect(() => store.flush()).not.toThrow()

    expect(fault.fired).toBeGreaterThan(0)
    expect(logged.mock.calls.map((call) => String(call[0]))).toContain(
      '[persistence] Failed to flush state:'
    )
    expect(sha256(dataFile())).toBe(publishedHash)
    expect(tempSiblings()).toEqual([])
  })

  it('a failed debounced save logs and is retried only by the next save or flush, not by a timer', async () => {
    vi.useFakeTimers()
    const { store, publishedHash } = await storeWithPublishedRepo()
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    fault.armed = true

    await vi.advanceTimersByTimeAsync(1_000)
    await store.waitForPendingWrite()

    expect(fault.fired, 'the debounced save must have reached the injector').toBeGreaterThan(0)
    expect(logged.mock.calls.map((call) => String(call[0]))).toContain(
      '[persistence] Failed to write state:'
    )
    expect(sha256(dataFile())).toBe(publishedHash)
    expect(tempSiblings()).toEqual([])
    // Characterizes a stated weakness (onFailure): nothing re-arms the save. If a retry timer is
    // ever added, invert this expectation and update the contract text.
    expect(vi.getTimerCount()).toBe(0)
    fault.armed = false

    await store.flushPendingAsync()

    expect(publishedRepoIds()).toEqual(['published', 'pending'])
  })

  it('the quit flush resolves despite ENOSPC and the previous file is intact', async () => {
    const { store, publishedHash } = await storeWithPublishedRepo()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    fault.armed = true

    await expect(store.flushAsync()).resolves.toBeUndefined()

    expect(fault.fired, 'the injector must have run').toBeGreaterThan(0)
    expect(sha256(dataFile())).toBe(publishedHash)
    expect(tempSiblings()).toEqual([])
  })

  it('the Codex reset-credit ledger rolls back and rejects with ENOSPC when its durability barrier fails', async () => {
    const store = await createStore()
    const attempt = (idempotencyKey: string, accountId: string) => ({
      idempotencyKey,
      expectedScope: {
        target: { runtime: 'host' as const, wslDistro: null },
        accountId,
        accountRevision: 1,
        offerRevision: 'v1:offer'
      },
      state: 'providerPending' as const
    })
    const first = {
      version: 1 as const,
      attempts: [attempt('11111111-1111-4111-8111-111111111111', 'acct-1')]
    }
    store.replaceCodexResetCreditAttemptLedgerAndFlush(first)
    const publishedHash = sha256(dataFile())
    fault.armed = true

    let failure: unknown = null
    try {
      store.replaceCodexResetCreditAttemptLedgerAndFlush({
        version: 1,
        attempts: [...first.attempts, attempt('22222222-2222-4222-8222-222222222222', 'acct-2')]
      })
    } catch (error) {
      failure = error
    }

    expect(fault.fired, 'the injector must have run').toBeGreaterThan(0)
    expect((failure as NodeJS.ErrnoException | null)?.code).toBe('ENOSPC')
    expect(store.getCodexResetCreditAttemptLedger()).toEqual(first)
    expect(sha256(dataFile())).toBe(publishedHash)
  })
})
