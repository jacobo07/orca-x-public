import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as FsPromises from 'node:fs/promises'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const io = vi.hoisted(() => ({ stat: 0, readdir: 0, inFlight: 0 }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>()
  const count =
    <A extends unknown[], R>(key: 'stat' | 'readdir', fn: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      io[key]++
      io.inFlight++
      try {
        return await fn(...args)
      } finally {
        io.inFlight--
      }
    }
  const stat = count('stat', actual.stat as (...args: unknown[]) => Promise<unknown>)
  const readdir = count('readdir', actual.readdir as (...args: unknown[]) => Promise<unknown>)
  return { ...actual, default: { ...actual, stat, readdir }, stat, readdir }
})

vi.mock('../providers/ssh-filesystem-dispatch', () => ({
  getSshFilesystemProvider: () => undefined
}))

import type { GlobalSettings } from '../../shared/global-settings-types'
import type { Repo } from '../../shared/repo-types'
import { buildWorktreeBaseDirectoryWatchTargets } from './worktree-base-directory-watch-targets'
import {
  startWorktreeBaseDirectoryPoller,
  WORKTREE_BASE_POLL_INTERVAL_MS,
  type WorktreeBaseSubscription
} from './worktree-base-directory-poller'

// Why: measures the recurring cost of observing every repo in the store, at the scale users grow
// to — the Resource Elasticity first shrink (docs/reference/resource-elasticity-fabric.md).
const LINKED_WORKTREES_PER_REPO = 3
const MEASURED_CYCLES = 10
// Longer than any activity window, so every target is idle for the second measurement.
const IDLE_JUMP_MS = 10 * 60_000

type Curve = {
  targets: number
  timers: number
  hotStats: number
  idleStats: number
  readdirs: number
}

async function writeGitFiles(dir: string, names: string[]): Promise<void> {
  await mkdir(join(dir, 'logs'), { recursive: true })
  await Promise.all(names.map((name) => writeFile(join(dir, name), 'x')))
}

async function seedRepos(root: string, count: number): Promise<Repo[]> {
  const workspaces = join(root, 'workspaces')
  await mkdir(workspaces, { recursive: true })
  const repos: Repo[] = []
  for (let r = 0; r < count; r++) {
    const repoPath = join(root, 'repos', `repo-${r}`)
    const common = join(repoPath, '.git')
    await writeGitFiles(common, ['HEAD', 'config', 'index', 'packed-refs', join('logs', 'HEAD')])
    for (let w = 0; w < LINKED_WORKTREES_PER_REPO; w++) {
      const name = `wt-${r}-${w}`
      await writeGitFiles(join(common, 'worktrees', name), [
        'HEAD',
        'gitdir',
        'commondir',
        'index',
        join('logs', 'HEAD')
      ])
      const checkout = join(workspaces, name)
      await mkdir(checkout, { recursive: true })
      await writeFile(join(checkout, '.git'), `gitdir: ${join(common, 'worktrees', name)}`)
    }
    repos.push({ id: `repo-${r}`, path: repoPath, displayName: `repo-${r}` } as Repo)
  }
  return repos
}

async function settleIo(): Promise<void> {
  let quiet = 0
  for (let turn = 0; turn < 5_000 && quiet < 3; turn++) {
    await new Promise<void>((resolve) => setImmediate(resolve))
    quiet = io.inFlight === 0 ? quiet + 1 : 0
  }
  if (io.inFlight !== 0) {
    throw new Error('HARNESS-FAILED: filesystem calls never settled')
  }
}

async function runCycles(cycles: number): Promise<void> {
  for (let cycle = 0; cycle < cycles; cycle++) {
    await vi.advanceTimersByTimeAsync(WORKTREE_BASE_POLL_INTERVAL_MS)
    await settleIo()
    await vi.advanceTimersByTimeAsync(0)
    await settleIo()
  }
}

describe('worktree observation cardinality', () => {
  const cleanups: (() => Promise<void>)[] = []

  afterEach(async () => {
    vi.useRealTimers()
    for (const cleanup of cleanups.splice(0).toReversed()) {
      await cleanup()
    }
  })

  async function measure(repoCount: number): Promise<Curve> {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'orca-observation-curve-')))
    cleanups.push(() => rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }))
    const repos = await seedRepos(root, repoCount)
    const settings = {
      workspaceDir: join(root, 'workspaces'),
      nestWorkspaces: false
    } as GlobalSettings
    const targets = await buildWorktreeBaseDirectoryWatchTargets({
      getSettings: () => settings,
      getRepos: () => repos
    } as never)

    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date']
    })
    const timersBefore = vi.getTimerCount()
    const subscriptions: WorktreeBaseSubscription[] = []
    for (const target of targets.values()) {
      subscriptions.push(
        await startWorktreeBaseDirectoryPoller(
          target,
          () => target.repos,
          () => {},
          {
            platform: 'win32'
          }
        )
      )
    }
    const unsubscribeAll = async (): Promise<void> => {
      await Promise.all(subscriptions.splice(0).map((subscription) => subscription.unsubscribe()))
    }
    cleanups.push(unsubscribeAll)
    await settleIo()
    const timers = vi.getTimerCount() - timersBefore

    io.stat = 0
    io.readdir = 0
    await runCycles(MEASURED_CYCLES)
    const hotStats = io.stat
    const readdirs = io.readdir

    vi.setSystemTime(Date.now() + IDLE_JUMP_MS)
    await runCycles(MEASURED_CYCLES)
    io.stat = 0
    await runCycles(MEASURED_CYCLES)
    const idleStats = io.stat

    await unsubscribeAll()
    expect(vi.getTimerCount() - timersBefore, 'every subscription released its timer').toBe(0)
    return { targets: targets.size, timers, hotStats, idleStats, readdirs }
  }

  it(
    'keeps one clock and cuts idle stat work as repositories grow',
    { timeout: 120_000 },
    async () => {
      const curve = new Map<number, Curve>()
      for (const repoCount of [1, 10, 50]) {
        curve.set(repoCount, await measure(repoCount))
      }
      const curveOut = process.env.ORCA_OBSERVATION_CURVE_OUT
      if (curveOut) {
        await writeFile(curveOut, JSON.stringify(Object.fromEntries(curve), null, 2))
      }

      const one = curve.get(1)!
      const fifty = curve.get(50)!
      // Positive controls: the sweep saw every repo, and every repo was actually observed.
      expect(fifty.targets).toBe(51)
      expect(fifty.hotStats).toBeGreaterThanOrEqual(50 * 25 * MEASURED_CYCLES)
      expect(one.hotStats).toBeGreaterThan(0)

      for (const point of curve.values()) {
        expect(point.timers, 'one shared clock regardless of target count').toBeLessThanOrEqual(1)
        expect(point.idleStats * 4, 'idle repositories cost at most a quarter').toBeLessThanOrEqual(
          point.hotStats
        )
        expect(point.idleStats, 'idle repositories are still observed').toBeGreaterThan(0)
      }
    }
  )
})
