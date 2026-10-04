import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as FsPromises from 'node:fs/promises'
import type * as ObservationClock from './worktree-observation-clock'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { Repo } from '../../shared/repo-types'

const listing = vi.hoisted(() => ({ failPaths: new Set<string>(), failures: 0 }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>()
  return {
    ...actual,
    readdir: ((...args: Parameters<typeof FsPromises.readdir>) => {
      if (listing.failPaths.has(String(args[0]))) {
        listing.failures++
        throw Object.assign(new Error('EACCES: listing failed'), { code: 'EACCES' })
      }
      return (actual.readdir as (...a: unknown[]) => unknown)(...args)
    }) as typeof FsPromises.readdir
  }
})

// Why: the production clock ticks every 2 s; the real poller and watcher run unchanged on a fast clock.
vi.mock('./worktree-observation-clock', async (importOriginal) => {
  const actual = await importOriginal<typeof ObservationClock>()
  let clock: ReturnType<typeof actual.createWorktreeObservationClock> | null = null
  return {
    ...actual,
    getWorktreeObservationClock: () => (clock ??= actual.createWorktreeObservationClock(25))
  }
})

vi.mock('./worktree-remote', () => ({
  notifyWorktreeGitStatusMetadataChanged: vi.fn(),
  notifyWorktreeHeadIdentitiesChanged: vi.fn(),
  notifyWorktreesChanged: vi.fn()
}))

vi.mock('../providers/ssh-filesystem-dispatch', () => ({
  getSshFilesystemProvider: vi.fn(() => undefined)
}))

import { notifyWorktreesChanged } from './worktree-remote'
import {
  disposeWorktreeBaseDirectoryWatchers,
  syncWorktreeBaseDirectoryWatchers
} from './worktree-base-directory-watcher'

const WATCHER_FAILED = '[worktree-base-watcher] watcher failed for'

async function waitFor(predicate: () => boolean, what: string): Promise<void> {
  await vi.waitFor(
    () => {
      if (!predicate()) {
        throw new Error(`not yet: ${what}`)
      }
    },
    { timeout: 5_000, interval: 20 }
  )
}

describe('worktree base directory watcher: a listing failure present when the watch starts', () => {
  const cleanups: (() => Promise<void>)[] = []
  let warn: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    listing.failPaths.clear()
    listing.failures = 0
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(async () => {
    listing.failPaths.clear()
    await disposeWorktreeBaseDirectoryWatchers()
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
    vi.mocked(notifyWorktreesChanged).mockClear()
    warn.mockRestore()
  })

  async function layout() {
    const raw = await mkdtemp(join(tmpdir(), 'orca-base-watcher-startup-'))
    cleanups.push(() => rm(raw, { recursive: true, force: true }))
    const root = await realpath(raw)
    const container = join(root, 'project')
    await mkdir(join(container, 'wt-a'), { recursive: true })
    await writeFile(join(container, 'wt-a', '.git'), 'gitdir: elsewhere')
    const repo = {
      id: 'repo-1',
      path: join(root, 'repos', 'project'),
      displayName: 'Project',
      badgeColor: '#000000',
      addedAt: 1
    } as Repo
    const settings = { workspaceDir: root, nestWorkspaces: true } as GlobalSettings
    const store = { getSettings: () => settings, getRepos: () => [repo] }
    const window = { isDestroyed: () => false, webContents: { send: vi.fn() } }
    return { root, container, store, window }
  }

  const watcherFailures = (): unknown[][] =>
    warn.mock.calls.filter((call) => String(call[0]).startsWith(WATCHER_FAILED))

  it('reaches the watcher error path and schedules the structure refresh instead of dropping the report', async () => {
    // Arrange
    const { container, store, window } = await layout()
    listing.failPaths.add(container)

    // Act
    await syncWorktreeBaseDirectoryWatchers(store as never, window as never)
    await waitFor(() => listing.failures >= 3, 'several failing ticks ran')
    await waitFor(() => vi.mocked(notifyWorktreesChanged).mock.calls.length > 0, 'the refresh ran')

    // Assert
    const failures = watcherFailures()
    expect(failures).toHaveLength(1)
    expect(String((failures[0][1] as Error).message)).toContain(container)
    expect(notifyWorktreesChanged).toHaveBeenCalledWith(expect.anything(), 'repo-1')
  })

  it('reaches the watcher error path when the base root itself is unlistable at startup', async () => {
    // Arrange
    const { root, store, window } = await layout()
    listing.failPaths.add(root)

    // Act
    await syncWorktreeBaseDirectoryWatchers(store as never, window as never)
    await waitFor(() => listing.failures >= 3, 'several failing ticks ran')

    // Assert
    const failures = watcherFailures()
    expect(failures).toHaveLength(1)
    expect(String((failures[0][1] as Error).message)).toContain(root)
  })

  it('control: a failure that starts after the watch is live is reported through the same path', async () => {
    // Arrange
    const { container, store, window } = await layout()
    await syncWorktreeBaseDirectoryWatchers(store as never, window as never)

    // Act
    listing.failPaths.add(container)
    // Why: touching the container flips its dir-signature gate so the next tick lists it.
    await mkdir(join(container, 'wt-touch'))
    await waitFor(() => watcherFailures().length > 0, 'the late failure is reported')

    // Assert
    expect(watcherFailures()).toHaveLength(1)
    expect(String((watcherFailures()[0][1] as Error).message)).toContain(container)
  })
})
