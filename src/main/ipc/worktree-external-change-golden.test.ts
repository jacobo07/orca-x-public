import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../providers/ssh-filesystem-dispatch', () => ({
  getSshFilesystemProvider: () => undefined
}))

import type { GlobalSettings } from '../../shared/global-settings-types'
import type { Repo } from '../../shared/repo-types'
import { buildWorktreeBaseDirectoryWatchTargets } from './worktree-base-directory-watch-targets'
import {
  startWorktreeBaseDirectoryPoller,
  type WorktreeBasePollEvent,
  type WorktreeBaseSubscription
} from './worktree-base-directory-poller'
import { WORKTREE_OBSERVATION_ACTIVE_WINDOW_MS } from './worktree-observation-clock'

// Why: the polls exist to notice changes made OUTSIDE Orca. Git runs as a separate process here and
// nothing notifies the poller, so a green run proves the production observation path saw it.
const POLL_MS = 40

function git(cwd: string, args: string[]): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`HARNESS-FAILED: git ${args.join(' ')}: ${result.stderr || result.error}`)
  }
}

type Received = { kind: string; event: WorktreeBasePollEvent }

describe('external worktree changes reach the production observer', () => {
  const cleanups: (() => Promise<void>)[] = []

  afterEach(async () => {
    vi.useRealTimers()
    for (const cleanup of cleanups.splice(0).toReversed()) {
      await cleanup()
    }
  })

  async function observeRealRepo(): Promise<{
    repoPath: string
    workspaces: string
    received: Received[]
  }> {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'orca-external-worktree-')))
    cleanups.push(() => rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }))
    const repoPath = join(root, 'repo')
    const workspaces = join(root, 'workspaces')
    await mkdir(repoPath)
    await mkdir(workspaces)
    git(repoPath, ['init', '-q', '-b', 'main'])
    git(repoPath, ['config', 'user.email', 'golden@example.invalid'])
    git(repoPath, ['config', 'user.name', 'golden'])
    await writeFile(join(repoPath, 'README.md'), 'golden')
    git(repoPath, ['add', '.'])
    git(repoPath, ['commit', '-q', '-m', 'init'])

    const repos = [{ id: 'repo-1', path: repoPath, displayName: 'repo' } as Repo]
    const settings = { workspaceDir: workspaces, nestWorkspaces: false } as GlobalSettings
    const targets = await buildWorktreeBaseDirectoryWatchTargets({
      getSettings: () => settings,
      getRepos: () => repos
    } as never)
    expect([...targets.values()].map((target) => target.kind).sort()).toEqual([
      'base',
      'git-common'
    ])

    const received: Received[] = []
    const subscriptions: WorktreeBaseSubscription[] = []
    for (const target of targets.values()) {
      subscriptions.push(
        await startWorktreeBaseDirectoryPoller(
          target,
          () => target.repos,
          (events) => received.push(...events.map((event) => ({ kind: target.kind, event }))),
          { pollIntervalMs: POLL_MS, platform: 'win32' }
        )
      )
    }
    cleanups.push(async () => {
      await Promise.all(subscriptions.map((subscription) => subscription.unsubscribe()))
    })
    return { repoPath, workspaces, received }
  }

  async function expectObserved(
    received: Received[],
    predicate: (entry: Received) => boolean,
    what: string
  ): Promise<void> {
    await vi.waitFor(
      () => {
        if (!received.some(predicate)) {
          throw new Error(`not observed yet: ${what}`)
        }
      },
      { timeout: 10_000, interval: 20 }
    )
  }

  async function addAndRemoveExternally(
    repoPath: string,
    workspaces: string,
    received: Received[]
  ) {
    const linked = join(workspaces, 'external')
    git(repoPath, ['worktree', 'add', '-q', '-b', 'external', linked])
    await expectObserved(
      received,
      ({ kind, event }) =>
        kind === 'git-common' &&
        event.type === 'create' &&
        event.path === join(repoPath, '.git', 'worktrees', 'external'),
      'linked worktree registration'
    )
    await expectObserved(
      received,
      ({ kind, event }) =>
        kind === 'base' && event.type === 'create' && event.path === join(linked, '.git'),
      'checkout completion marker'
    )

    git(repoPath, ['worktree', 'remove', '--force', linked])
    await expectObserved(
      received,
      ({ kind, event }) =>
        kind === 'git-common' &&
        event.type === 'delete' &&
        event.path === join(repoPath, '.git', 'worktrees', 'external'),
      'linked worktree deregistration'
    )
    await expectObserved(
      received,
      ({ kind, event }) => kind === 'base' && event.type === 'delete' && event.path === linked,
      'checkout removal'
    )
  }

  it('sees an external git worktree add and remove', { timeout: 60_000 }, async () => {
    const { repoPath, workspaces, received } = await observeRealRepo()
    await addAndRemoveExternally(repoPath, workspaces, received)
  })

  it(
    'still sees external changes after the repository has gone quiet',
    { timeout: 60_000 },
    async () => {
      const { repoPath, workspaces, received } = await observeRealRepo()
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(Date.now() + WORKTREE_OBSERVATION_ACTIVE_WINDOW_MS * 2)
      // Let at least one cycle observe the quiet state before git runs.
      await new Promise((resolve) => setTimeout(resolve, POLL_MS * 12))
      await addAndRemoveExternally(repoPath, workspaces, received)
    }
  )
})
