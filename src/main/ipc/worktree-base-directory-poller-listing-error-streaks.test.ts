import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as FsPromises from 'node:fs/promises'
import { startWorktreeBaseDirectoryPoller } from './worktree-base-directory-poller'
import type {
  WorktreeBaseRepoWatchConfig,
  WorktreeBaseWatchTarget
} from './worktree-base-directory-event-filter'

const listing = vi.hoisted(() => ({ failPaths: new Set<string>() }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>()
  return {
    ...actual,
    readdir: ((...args: Parameters<typeof FsPromises.readdir>) => {
      if (listing.failPaths.has(String(args[0]))) {
        throw Object.assign(new Error('EIO: listing failed'), { code: 'EIO' })
      }
      return (actual.readdir as (...a: unknown[]) => unknown)(...args)
    }) as typeof FsPromises.readdir
  }
})

const POLL_MS = 25

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

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, POLL_MS * 6))

describe('worktree base poller listing-error reporting is per failing directory', () => {
  const cleanups: (() => Promise<void>)[] = []

  beforeEach(() => {
    listing.failPaths.clear()
  })

  afterEach(async () => {
    listing.failPaths.clear()
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
  })

  async function start(sink: (error: Error) => boolean | void = () => {}) {
    const raw = await mkdtemp(join(tmpdir(), 'orca-base-poller-streaks-'))
    cleanups.push(() => rm(raw, { recursive: true, force: true }))
    const root = await realpath(raw)
    const containerA = join(root, 'project-a')
    const containerB = join(root, 'project-b')
    for (const container of [containerA, containerB]) {
      await mkdir(join(container, 'wt-1'), { recursive: true })
      await writeFile(join(container, 'wt-1', '.git'), 'gitdir: elsewhere')
    }
    const repos = new Map<string, WorktreeBaseRepoWatchConfig>([
      ['repo-a', { repoId: 'repo-a', repoName: 'project-a', nestWorkspaces: true }],
      ['repo-b', { repoId: 'repo-b', repoName: 'project-b', nestWorkspaces: true }]
    ])
    const target = { key: `base:local:${root}`, kind: 'base', path: root, repos }
    const reported: string[] = []
    const poller = await startWorktreeBaseDirectoryPoller(
      target as WorktreeBaseWatchTarget,
      () => repos,
      () => {},
      {
        pollIntervalMs: POLL_MS,
        onWatchError: (error) => {
          reported.push(error.message)
          return sink(error)
        }
      }
    )
    cleanups.push(() => poller.unsubscribe())
    // Why: touching a container flips its dir-signature gate so the next tick lists it.
    const touch = (container: string, name: string) => mkdir(join(container, name))
    const reportedFor = (path: string): number =>
      reported.filter((message) => message === `Could not scan worktree directory ${path} (EIO)`)
        .length
    return { root, containerA, containerB, touch, reported, reportedFor }
  }

  it('reports a second container that starts failing while the first is still failing', async () => {
    // Arrange
    const { containerA, containerB, touch, reportedFor } = await start()
    listing.failPaths.add(containerA)
    await touch(containerA, 'noise-a')
    await waitFor(() => reportedFor(containerA) === 1, 'the first failure is reported')

    // Act
    listing.failPaths.add(containerB)
    await touch(containerB, 'noise-b')
    await waitFor(() => reportedFor(containerB) === 1, 'the second failure is reported')
    await settle()

    // Assert
    expect(reportedFor(containerA)).toBe(1)
    expect(reportedFor(containerB)).toBe(1)
  })

  it('still reports the second container when the first recovers while the second keeps failing', async () => {
    // Arrange
    const { containerA, containerB, touch, reportedFor } = await start()
    listing.failPaths.add(containerA)
    await touch(containerA, 'noise-a')
    await waitFor(() => reportedFor(containerA) === 1, 'the first failure is reported')
    listing.failPaths.add(containerB)
    await touch(containerB, 'noise-b')

    // Act
    listing.failPaths.delete(containerA)
    await waitFor(() => reportedFor(containerB) === 1, 'the second failure is reported')
    await settle()

    // Assert
    expect(reportedFor(containerA)).toBe(1)
    expect(reportedFor(containerB)).toBe(1)
  })

  it('reports every directory that fails in the same scan', async () => {
    // Arrange
    const { containerA, containerB, touch, reportedFor } = await start()
    listing.failPaths.add(containerA)
    listing.failPaths.add(containerB)

    // Act
    await touch(containerA, 'noise-a')
    await waitFor(
      () => reportedFor(containerA) === 1 && reportedFor(containerB) === 1,
      'both failures are reported'
    )
    await settle()

    // Assert
    expect(reportedFor(containerA)).toBe(1)
    expect(reportedFor(containerB)).toBe(1)
  })

  it('re-arms only the directory that recovered', async () => {
    // Arrange
    const { containerA, containerB, touch, reportedFor } = await start()
    listing.failPaths.add(containerA)
    listing.failPaths.add(containerB)
    await touch(containerA, 'noise-a')
    await waitFor(
      () => reportedFor(containerA) === 1 && reportedFor(containerB) === 1,
      'both failures are reported'
    )

    // Act
    listing.failPaths.delete(containerA)
    await settle()
    listing.failPaths.add(containerA)
    await touch(containerA, 'noise-a2')
    await waitFor(() => reportedFor(containerA) === 2, 'the recovered directory fails again')
    await settle()

    // Assert
    expect(reportedFor(containerA)).toBe(2)
    expect(reportedFor(containerB)).toBe(1)
  })

  it('reports a root listing failure that arrives during an open container streak', async () => {
    // Arrange
    const { root, containerA, touch, reportedFor } = await start()
    listing.failPaths.add(containerA)
    await touch(containerA, 'noise-a')
    await waitFor(() => reportedFor(containerA) === 1, 'the container failure is reported')

    // Act
    listing.failPaths.add(root)
    await waitFor(() => reportedFor(root) >= 1, 'the root failure is reported')
    await settle()
    // Why: a scan that threw at the root never reached the container, so it must stay latched when the root lists again.
    listing.failPaths.delete(root)
    await settle()

    // Assert
    expect(reportedFor(containerA)).toBe(1)
    expect(reportedFor(root)).toBe(1)
  })

  it('offers a report again on the next tick when the sink did not deliver it', async () => {
    // Arrange
    let refusals = 2
    const { containerA, touch, reportedFor } = await start(() => refusals-- <= 0)
    listing.failPaths.add(containerA)

    // Act
    await touch(containerA, 'noise-a')
    await waitFor(() => reportedFor(containerA) >= 3, 'the report is retried until it is delivered')
    await settle()

    // Assert
    expect(reportedFor(containerA)).toBe(3)
  })
})
