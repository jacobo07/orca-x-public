import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type * as NodeFs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Why only readFileSync is intercepted: the destructive leg is the real writeFileSync/renameSync
// pair. Faking those would prove nothing about what lands on disk.
const readFailures = vi.hoisted(() => {
  const state = {
    pending: new Map<string, NodeJS.ErrnoException>(),
    failOnce(target: string, error: NodeJS.ErrnoException): void {
      state.pending.set(target.replaceAll('\\', '/'), error)
    },
    take(target: unknown): NodeJS.ErrnoException | null {
      if (typeof target !== 'string') {
        return null
      }
      const key = target.replaceAll('\\', '/')
      const failure = state.pending.get(key)
      if (!failure) {
        return null
      }
      state.pending.delete(key)
      return failure
    },
    reset(): void {
      state.pending.clear()
    }
  }
  return state
})

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  const patched = {
    ...actual,
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      const failure = readFailures.take(args[0])
      if (failure) {
        throw failure
      }
      return actual.readFileSync(...args)
    }
  }
  return { ...patched, default: patched }
})

const DEFAULT_PARTITION = 'persist:orca-browser'

function seededMeta(): Record<string, unknown> {
  return {
    defaultSource: 'chrome',
    pendingCookieImports: {},
    profiles: [
      { id: 'profile-work', name: 'Work', source: 'chrome' },
      { id: 'profile-personal', name: 'Personal', source: 'chrome' }
    ]
  }
}

describe('browser session meta survives a transient read failure', () => {
  let dir: string
  let metaPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-browser-meta-'))
    metaPath = join(dir, 'browser-session-meta.json')
    readFailures.reset()
  })

  afterEach(() => {
    readFailures.reset()
    rmSync(dir, { recursive: true, force: true })
  })

  it('does not erase profiles when the read leg fails while persisting an unrelated field', async () => {
    const { persistBrowserSessionMeta } = await import('./browser-session-meta-store')
    writeFileSync(metaPath, JSON.stringify(seededMeta()), 'utf-8')

    // A Windows AV scanner holding an exclusive handle, or an EIO on a degraded mount: the file is
    // intact on disk and readable again a moment later.
    readFailures.failOnce(metaPath, Object.assign(new Error('meta locked'), { code: 'EBUSY' }))

    persistBrowserSessionMeta(() => metaPath, DEFAULT_PARTITION, {
      pendingCookieImports: { [DEFAULT_PARTITION]: '/tmp/cookies.db' }
    })

    const persisted = JSON.parse(readFileSync(metaPath, 'utf-8'))
    // The merge seeds itself from the failed read, so an unreadable file becomes an empty baseline
    // and the atomic rename publishes that erasure over the only copy.
    expect(
      persisted.profiles,
      `profiles erased by a transient read failure: ${JSON.stringify(persisted)}`
    ).toHaveLength(2)
    expect(persisted.defaultSource).toBe('chrome')
  })

  it('keeps the stored profiles when the read leg fails while persisting a profile list', async () => {
    const { persistBrowserSessionMeta } = await import('./browser-session-meta-store')
    writeFileSync(metaPath, JSON.stringify(seededMeta()), 'utf-8')

    readFailures.failOnce(metaPath, Object.assign(new Error('meta locked'), { code: 'EBUSY' }))

    persistBrowserSessionMeta(() => metaPath, DEFAULT_PARTITION, {
      profiles: [{ id: 'profile-work', name: 'Work', source: 'chrome' }] as never
    })

    const persisted = JSON.parse(readFileSync(metaPath, 'utf-8'))
    // An explicit profile update is legitimate, but defaultSource was never part of this write and
    // must not be silently reset by a failed read.
    expect(persisted.defaultSource, 'unrelated field lost to a failed read').toBe('chrome')
  })
})
