import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'

type ObservationClockSnapshot = {
  intervalMs: number
  registrations: number
  parked: number
  running: boolean
  cycles: number
  runs: number
}

async function readObservation(
  electronApp: ElectronApplication
): Promise<ObservationClockSnapshot[]> {
  return electronApp.evaluate(() => {
    const read = (globalThis as { __orcaWorktreeObservation?: () => ObservationClockSnapshot[] })
      .__orcaWorktreeObservation
    if (!read) {
      throw new Error('worktree observation hook is not installed in the main process')
    }
    return read()
  })
}

// Why: reads the store only. Calling fetchWorktrees here would hide whether the watcher refreshed it.
async function storedWorktreePaths(page: Page, repoId: string): Promise<string[]> {
  return page.evaluate(
    (repoId) =>
      (window.__store?.getState().worktreesByRepo[repoId] ?? []).map((worktree) =>
        worktree.path.replaceAll('\\', '/').toLowerCase()
      ),
    repoId
  )
}

const normalizePath = (value: string): string => value.replaceAll('\\', '/').toLowerCase()

test.describe('External worktree changes in the running app', () => {
  test('a git worktree add/remove outside Orca reaches the sidebar through the shared observation clock', async ({
    electronApp,
    orcaPage,
    testRepoPath
  }) => {
    const repoId = await orcaPage.evaluate((testRepoPath) => {
      const normalize = (value: string): string => value.replaceAll('\\', '/').toLowerCase()
      const repos = window.__store?.getState().repos ?? []
      const repo = repos.find((item) => normalize(item.path) === normalize(testRepoPath))
      if (!repo) {
        throw new Error(
          `HARNESS-FAILED: seeded repo ${testRepoPath} not in [${repos.map((item) => item.path).join(', ')}]`
        )
      }
      return repo.id
    }, testRepoPath)

    // The seeded repo is observed by one production clock, not one timer per target.
    await expect
      .poll(async () => (await readObservation(electronApp)).find((c) => c.intervalMs === 2_000))
      .toMatchObject({ running: true })
    const clocks = await readObservation(electronApp)
    expect(clocks).toHaveLength(1)
    const [before] = clocks
    expect(before.registrations).toBeGreaterThanOrEqual(1)

    const parent = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orca-external-observation-')))
    const linked = path.join(parent, 'external-linked')
    try {
      expect(await storedWorktreePaths(orcaPage, repoId)).not.toContain(normalizePath(linked))
      execFileSync('git', ['worktree', 'add', '--detach', linked, 'HEAD'], {
        cwd: testRepoPath,
        stdio: 'pipe'
      })
      const registered = normalizePath(realpathSync(linked))
      await expect
        .poll(() => storedWorktreePaths(orcaPage, repoId), {
          timeout: 20_000,
          message: 'external worktree never reached the store without an explicit fetch'
        })
        .toContain(registered)

      execFileSync('git', ['worktree', 'remove', '--force', linked], {
        cwd: testRepoPath,
        stdio: 'pipe'
      })
      await expect
        .poll(() => storedWorktreePaths(orcaPage, repoId), {
          timeout: 20_000,
          message: 'external worktree removal never reached the store'
        })
        .not.toContain(registered)
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }

    // Recurring work in the running app: at most one run per registration per cycle.
    const [after] = await readObservation(electronApp)
    const cycles = after.cycles - before.cycles
    expect(cycles).toBeGreaterThan(0)
    expect(after.runs - before.runs).toBeLessThanOrEqual(cycles * after.registrations + 2)
    test.info().annotations.push({
      type: 'observation',
      description: JSON.stringify({ before, after })
    })
  })
})
