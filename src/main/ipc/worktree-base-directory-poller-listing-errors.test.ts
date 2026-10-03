import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as FsPromises from 'node:fs/promises'
import {
  startWorktreeBaseDirectoryPoller,
  type WorktreeBasePollEvent
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
})
