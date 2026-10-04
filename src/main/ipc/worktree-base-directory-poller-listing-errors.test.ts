import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as FsPromises from 'node:fs/promises'
import {
  startWorktreeBaseDirectoryPoller,
  WORKTREE_BASE_BACKSTOP_TICKS,
  type WorktreeBasePollEvent,
  type WorktreeBasePollerOptions
} from './worktree-base-directory-poller'
import type {
  WorktreeBaseRepoWatchConfig,
  WorktreeBaseWatchTarget
} from './worktree-base-directory-event-filter'

const listing = vi.hoisted(() => ({
  failPath: null as string | null,
  code: '',
  failures: 0
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>()
  return {
    ...actual,
    readdir: ((...args: Parameters<typeof FsPromises.readdir>) => {
      if (listing.failPath !== null && String(args[0]) === listing.failPath) {
        listing.failures++
        throw Object.assign(new Error(`${listing.code}: listing failed`), { code: listing.code })
      }
      return (actual.readdir as (...a: unknown[]) => unknown)(...args)
    }) as typeof FsPromises.readdir
  }
})

const POLL_MS = 25

function makeTarget(root: string, config: Partial<WorktreeBaseRepoWatchConfig>) {
  const repo: WorktreeBaseRepoWatchConfig = {
    repoId: 'repo-1',
    repoName: 'project',
    nestWorkspaces: false,
    ...config
  }
  return { key: `base:local:${root}`, kind: 'base', path: root, repos: new Map([['repo-1', repo]]) }
}

function arm(path: string, code: string): void {
  listing.failPath = path
  listing.code = code
  listing.failures = 0
}

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

describe('worktree base poller listing errors', () => {
  const cleanups: (() => Promise<void>)[] = []

  beforeEach(() => {
    listing.failPath = null
    listing.code = ''
    listing.failures = 0
  })

  afterEach(async () => {
    listing.failPath = null
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
  })

  async function startWith(layout: { nest: boolean }) {
    const raw = await mkdtemp(join(tmpdir(), 'orca-base-poller-listing-'))
    cleanups.push(() => rm(raw, { recursive: true, force: true }))
    const root = await realpath(raw)
    const container = layout.nest ? join(root, 'project') : root
    const worktrees = [join(container, 'wt-a'), join(container, 'wt-b')]
    for (const worktree of worktrees) {
      await mkdir(worktree, { recursive: true })
      await writeFile(join(worktree, '.git'), 'gitdir: elsewhere')
    }
    const received: WorktreeBasePollEvent[][] = []
    const target = makeTarget(root, { nestWorkspaces: layout.nest })
    const poller = await startWorktreeBaseDirectoryPoller(
      target as WorktreeBaseWatchTarget,
      () => target.repos,
      (events) => received.push(events),
      { pollIntervalMs: POLL_MS }
    )
    cleanups.push(() => poller.unsubscribe())
    // Why: touching the root flips the dir-signature gate so the next tick runs a full listing.
    const touchRoot = async (name: string) => mkdir(join(root, name))
    return { root, container, worktrees, received, touchRoot }
  }

  async function startTwoContainers(
    onWatchError?: (error: Error) => void,
    extra: Partial<WorktreeBasePollerOptions> = {}
  ) {
    const raw = await mkdtemp(join(tmpdir(), 'orca-base-poller-two-'))
    cleanups.push(() => rm(raw, { recursive: true, force: true }))
    const root = await realpath(raw)
    const containerA = join(root, 'project-a')
    const containerB = join(root, 'project-b')
    const worktreeA = join(containerA, 'wt-a1')
    const worktreeB = join(containerB, 'wt-b1')
    for (const worktree of [worktreeA, worktreeB]) {
      await mkdir(worktree, { recursive: true })
      await writeFile(join(worktree, '.git'), 'gitdir: elsewhere')
    }
    const repos = new Map<string, WorktreeBaseRepoWatchConfig>([
      ['repo-a', { repoId: 'repo-a', repoName: 'project-a', nestWorkspaces: true }],
      ['repo-b', { repoId: 'repo-b', repoName: 'project-b', nestWorkspaces: true }]
    ])
    const target = { key: `base:local:${root}`, kind: 'base', path: root, repos }
    const received: WorktreeBasePollEvent[][] = []
    const poller = await startWorktreeBaseDirectoryPoller(
      target as WorktreeBaseWatchTarget,
      () => repos,
      (events) => received.push(events),
      { pollIntervalMs: POLL_MS, onWatchError, ...extra }
    )
    cleanups.push(() => poller.unsubscribe())
    const addWorktree = async (container: string, name: string) => {
      await mkdir(join(container, name), { recursive: true })
      await writeFile(join(container, name, '.git'), 'gitdir: elsewhere')
    }
    return { containerA, containerB, worktreeA, worktreeB, received, addWorktree }
  }

  it('a failing nested container does not hide a sibling container, and its own children are kept', async () => {
    // Arrange
    const { containerA, containerB, worktreeA, received, addWorktree } = await startTwoContainers()
    arm(containerA, 'EACCES')

    // Act
    await addWorktree(containerB, 'wt-b2')
    await waitFor(
      () =>
        received
          .flat()
          .some(
            (event) => event.type === 'create' && event.path === join(containerB, 'wt-b2', '.git')
          ),
      'the healthy sibling create is reported while project-a is unlistable'
    )

    // Assert
    expect(listing.failures).toBeGreaterThan(0)
    expect(received.flat().filter((event) => event.type === 'delete')).toEqual([])
    listing.failPath = null
    await rm(worktreeA, { recursive: true })
    await waitFor(
      () => received.flat().some((event) => event.type === 'delete' && event.path === worktreeA),
      'the failing container is read again once it recovers'
    )
  })

  it('reports an unlistable nested container once per failing streak, not on every tick', async () => {
    // Arrange
    const onWatchError = vi.fn()
    const { containerA, addWorktree, containerB } = await startTwoContainers(onWatchError)
    arm(containerA, 'EIO')

    // Act
    await addWorktree(containerB, 'wt-b2')
    await waitFor(() => listing.failures >= 4, 'several failing ticks ran')
    const reportedDuringStreak = onWatchError.mock.calls.length
    listing.failPath = null
    await addWorktree(containerB, 'wt-b3')
    await waitFor(
      () => listing.failPath === null && onWatchError.mock.calls.length >= 1,
      'recovery'
    )
    await new Promise((resolve) => setTimeout(resolve, POLL_MS * 4))
    arm(containerA, 'EIO')
    await addWorktree(containerB, 'wt-b4')
    await waitFor(() => listing.failures >= 1, 'the second streak ran')
    await waitFor(() => onWatchError.mock.calls.length >= 2, 'the second streak is reported')

    // Assert
    expect(reportedDuringStreak).toBe(1)
    expect(onWatchError.mock.calls[0][0]).toBeInstanceOf(Error)
    expect(String(onWatchError.mock.calls[0][0].message)).toContain(containerA)
    expect(onWatchError).toHaveBeenCalledTimes(2)
  })

  it('retries an unlistable nested container on consecutive ticks instead of waiting for the backstop scan', async () => {
    // Arrange
    const scanTicks: number[] = []
    const { containerA, containerB, addWorktree } = await startTwoContainers(undefined, {
      onSnapshotTaken: (tick) => {
        if (listing.failPath !== null) {
          scanTicks.push(tick)
        }
      }
    })
    arm(containerA, 'EIO')

    // Act
    await addWorktree(containerB, 'wt-b2')
    await waitFor(() => scanTicks.length >= 4, 'four scans ran while the container was unlistable')

    // Assert
    const firstFour = scanTicks.slice(0, 4)
    expect(firstFour[3] - firstFour[0]).toBe(3)
    expect(firstFour[3] - firstFour[0]).toBeLessThan(WORKTREE_BASE_BACKSTOP_TICKS)
  })

  it.each(['EIO', 'EACCES', 'EMFILE'])(
    'a root listing that fails with %s emits no deletes and the next good listing diffs against the old snapshot',
    async (code) => {
      // Arrange
      const { root, worktrees, received, touchRoot } = await startWith({ nest: false })
      arm(root, code)

      // Act
      await touchRoot('noise-1')
      await waitFor(() => listing.failures > 0, 'the failing listing ran')
      await new Promise((resolve) => setTimeout(resolve, POLL_MS * 4))
      const duringFailure = received.flat()
      listing.failPath = null
      await rm(worktrees[0], { recursive: true })
      await waitFor(
        () =>
          received.flat().some((event) => event.type === 'delete' && event.path === worktrees[0]),
        'the real removal is reported once the listing works'
      )

      // Assert
      expect(duringFailure).toEqual([])
      const after = received.flat()
      expect(after.filter((event) => event.type === 'delete').map((e) => e.path)).toEqual([
        worktrees[0]
      ])
      expect(after.filter((event) => event.type === 'create')).toEqual([])
    }
  )

  it.each(['ENOENT', 'ENOTDIR'])(
    'a root listing that fails with %s is an absent root and emits a delete for every known worktree',
    async (code) => {
      // Arrange
      const { root, worktrees, received, touchRoot } = await startWith({ nest: false })
      arm(root, code)

      // Act
      await touchRoot('noise-2')
      await waitFor(() => listing.failures > 0, 'the failing listing ran')
      await waitFor(
        () => received.flat().filter((event) => event.type === 'delete').length >= 2,
        'deletes for the vanished root'
      )

      // Assert
      const deleted = received
        .flat()
        .filter((event) => event.type === 'delete')
        .map((event) => event.path)
      expect(deleted.sort()).toEqual([...worktrees].sort())
    }
  )

  it('a nested container listing that fails with EIO keeps its children', async () => {
    // Arrange
    const { container, worktrees, received, touchRoot } = await startWith({ nest: true })
    arm(container, 'EIO')

    // Act
    await touchRoot('noise-3')
    await waitFor(() => listing.failures > 0, 'the failing container listing ran')
    await new Promise((resolve) => setTimeout(resolve, POLL_MS * 4))

    // Assert
    expect(worktrees).toHaveLength(2)
    expect(received.flat()).toEqual([])
  })

  it('a nested container listing that fails with ENOENT deletes its children', async () => {
    // Arrange
    const { container, worktrees, received, touchRoot } = await startWith({ nest: true })
    arm(container, 'ENOENT')

    // Act
    await touchRoot('noise-4')
    await waitFor(() => listing.failures > 0, 'the failing container listing ran')
    await waitFor(
      () => received.flat().filter((event) => event.type === 'delete').length >= 2,
      'deletes for the vanished container'
    )

    // Assert
    const deleted = received
      .flat()
      .filter((event) => event.type === 'delete')
      .map((event) => event.path)
    expect(deleted.sort()).toEqual([...worktrees].sort())
  })

  describe('when the root is unlistable at startup', () => {
    async function layoutRoot() {
      const raw = await mkdtemp(join(tmpdir(), 'orca-base-poller-startup-'))
      cleanups.push(() => rm(raw, { recursive: true, force: true }))
      const root = await realpath(raw)
      const worktrees = [join(root, 'wt-a'), join(root, 'wt-b')]
      for (const worktree of worktrees) {
        await mkdir(worktree, { recursive: true })
        await writeFile(join(worktree, '.git'), 'gitdir: elsewhere')
      }
      return { root, worktrees, target: makeTarget(root, { nestWorkspaces: false }) }
    }

    it('still resolves the poller instead of rejecting the subscription', async () => {
      // Arrange
      const { root, target } = await layoutRoot()
      arm(root, 'EIO')

      // Act
      const started = startWorktreeBaseDirectoryPoller(
        target as WorktreeBaseWatchTarget,
        () => target.repos,
        () => {},
        { pollIntervalMs: POLL_MS }
      )

      // Assert
      const poller = await started
      cleanups.push(() => poller.unsubscribe())
      expect(listing.failures).toBeGreaterThan(0)
    })

    it('rescans on the first tick once the root lists, and reports the existing worktrees as creates only', async () => {
      // Arrange
      const { root, worktrees, target } = await layoutRoot()
      arm(root, 'EIO')
      const received: WorktreeBasePollEvent[][] = []
      const scanTicks: number[] = []
      const poller = await startWorktreeBaseDirectoryPoller(
        target as WorktreeBaseWatchTarget,
        () => target.repos,
        (events) => received.push(events),
        { pollIntervalMs: POLL_MS, onSnapshotTaken: (tick) => void scanTicks.push(tick) }
      )
      cleanups.push(() => poller.unsubscribe())

      // Act
      listing.failPath = null
      await waitFor(() => scanTicks.length > 0, 'a scan ran after the root became listable')

      // Assert
      // Why: the backstop scan is tick 15; only the sentinel gate can force a scan on tick 1.
      expect(scanTicks[0]).toBeLessThan(WORKTREE_BASE_BACKSTOP_TICKS)
      const events = received.flat()
      expect(events.filter((event) => event.type === 'delete')).toEqual([])
      expect(
        events
          .filter((event) => event.type === 'create')
          .map((event) => event.path)
          .sort()
      ).toEqual(worktrees.map((worktree) => join(worktree, '.git')).sort())
    })
  })
})
