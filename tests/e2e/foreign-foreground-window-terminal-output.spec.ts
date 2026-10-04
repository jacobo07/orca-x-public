/**
 * I-05 L1: a foreign X window in front of two Orca windows must not freeze either window's terminal.
 *
 * The lead was a third, non-Orca window taking the foreground and the Orca terminals stopping their
 * paint. Windows has its own native-occlusion spec; this one drives the X11 face under xvfb with a
 * real window manager. Every station fact (a window manager answers, two Orca windows exist, the
 * foreign window is the ACTIVE X window at the start and at the end of the hold) is thrown through
 * the precondition marker, so a missing station reads as unmeasured and never as a product red.
 */

import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { PRECONDITION_FAILURE_MARKER } from './helpers/e2e-precondition'
import {
  ensureTerminalVisible,
  getActiveWorktreeId,
  getStoreState,
  waitForActiveWorktree
} from './helpers/store'
import {
  discoverActivePtyId,
  waitForActiveTerminalManager,
  waitForPaneCount
} from './helpers/terminal'
import { probeDirectWriteOutput } from './helpers/terminal-fresh-output-probes'

const FOREIGN_HOLD_MS = 30_000
const X_TOOL_TIMEOUT_MS = 20_000
const HOLD_PROBE_PAUSE_MS = 2_000

type OrcaWindow = { label: string; page: Page; ptyId: string }

function stationFailure(label: string, detail: string): Error {
  return new Error(`${PRECONDITION_FAILURE_MARKER} [${label}] ${detail}`)
}

function diag(line: string): void {
  console.error(`L1_DIAG ${line}`)
}

test('a terminal keeps painting while a foreign X window is in front @headful', async ({
  orcaPage,
  electronApp
}) => {
  test.skip(process.platform === 'win32', 'Windows has its own native-occlusion spec')
  test.setTimeout(FOREIGN_HOLD_MS * 3 + 300_000)

  // Why read once: this is the display `xvfb-run -a` allocated for this run, and every X child is
  // given it explicitly so none can land on another run's display.
  const display = process.env.DISPLAY ?? ''
  console.error(`L1_DIAG display=${display}`)
  if (display === '') {
    throw stationFailure('display', 'DISPLAY is empty; this spec needs an X server')
  }
  const xEnv = { ...process.env, DISPLAY: display }
  const x = (tool: string, args: string[]): string =>
    execFileSync(tool, args, { env: xEnv, timeout: X_TOOL_TIMEOUT_MS, encoding: 'utf8' }).trim()
  const activeWindowId = (): string => x('xdotool', ['getactivewindow'])

  // Only pids this test spawned are ever signalled.
  const spawnedPids: number[] = []
  const startChild = (tool: string, args: string[]): ChildProcess => {
    const child = spawn(tool, args, { env: xEnv, stdio: 'ignore' })
    if (child.pid === undefined) {
      throw stationFailure('spawn', `${tool} did not start`)
    }
    spawnedPids.push(child.pid)
    return child
  }

  const startedAt = Date.now()
  try {
    const hasWindowManager = (): boolean => {
      try {
        return x('xprop', ['-root', '_NET_SUPPORTING_WM_CHECK']).includes('window id #')
      } catch {
        return false
      }
    }
    if (!hasWindowManager()) {
      startChild('openbox', [])
      await expect
        .poll(hasWindowManager, { timeout: 15_000, message: 'no window manager answered' })
        .toBe(true)
        .catch(() => {
          throw stationFailure('window-manager', 'no EWMH window manager answered on the display')
        })
    }

    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    await waitForPaneCount(orcaPage, 1, 30_000)
    const windowA: OrcaWindow = {
      label: 'A',
      page: orcaPage,
      ptyId: await discoverActivePtyId(orcaPage)
    }

    // Why a second worktree: one window per worktree, so B must take a free one to own its own PTY.
    const worktreeA = await getActiveWorktreeId(orcaPage)
    const repoId = await orcaPage.evaluate((worktreeId) => {
      const state = window.__store?.getState()
      for (const [id, worktrees] of Object.entries(state?.worktreesByRepo ?? {})) {
        if ((worktrees ?? []).some((worktree) => worktree.id === worktreeId)) {
          return id
        }
      }
      return state?.activeRepoId ?? null
    }, worktreeA)
    if (!repoId || !worktreeA) {
      throw stationFailure('repo', 'window A has no repository to branch a second worktree from')
    }
    const worktreeB = await orcaPage.evaluate(async (id) => {
      const store = window.__store
      const created = await store!.getState().createWorktree(id, `e2e-l1-${Date.now()}`)
      await store!.getState().fetchWorktrees(id)
      return created.worktree.id
    }, repoId)
    const secondPage = await Promise.all([
      electronApp.waitForEvent('window', { timeout: 60_000 }),
      orcaPage.evaluate(() => window.api.ui.createWindow())
    ]).then(([page]) => page)
    await secondPage.waitForLoadState('domcontentloaded')
    await expect
      .poll(async () => getStoreState<boolean>(secondPage, 'persistedUIReady'), { timeout: 60_000 })
      .toBe(true)
    const claim = await secondPage.evaluate(
      async (args) => (await window.api.ui.claimWorkspace(args)).outcome,
      { repoId, worktreeId: worktreeB }
    )
    if (claim !== 'claimed') {
      throw stationFailure(
        'second-window-claim',
        `window B could not claim a free worktree: ${claim}`
      )
    }
    await secondPage.evaluate(
      async (args) => {
        const store = window.__store!
        await store.getState().fetchWorktrees(args.repoId)
        store.getState().setActiveRepo(args.repoId)
        store.getState().setActiveWorktree(args.worktreeId)
        store.getState().setActiveView('terminal')
        if ((store.getState().tabsByWorktree[args.worktreeId] ?? []).length === 0) {
          await store.getState().openNewTerminalTabInActiveWorkspace()
        }
      },
      { repoId, worktreeId: worktreeB }
    )
    await ensureTerminalVisible(secondPage)
    await waitForActiveTerminalManager(secondPage, 30_000)
    await waitForPaneCount(secondPage, 1, 30_000)
    const windowB: OrcaWindow = {
      label: 'B',
      page: secondPage,
      ptyId: await discoverActivePtyId(secondPage)
    }
    if (windowB.ptyId === windowA.ptyId) {
      throw stationFailure('distinct-ptys', 'both windows resolved one PTY')
    }
    const orcaWindows = [windowA, windowB]
    const openWindowCount = await countOpenWindows(electronApp)
    if (openWindowCount !== 2) {
      throw stationFailure(
        'two-orca-windows',
        `expected 2 open Orca windows, saw ${openWindowCount}`
      )
    }
    // Control while both windows are in front: a miss later is the foreign window, not the setup.
    for (const win of orcaWindows) {
      const ok = await probeDirectWriteOutput(win.page, win.ptyId, `L1_BASE_${win.label}`)
      diag(`baseline window=${win.label} pty=${win.ptyId} painted=${ok}`)
      if (!ok) {
        throw stationFailure(
          'baseline-paint',
          `window ${win.label} did not paint before the foreign window`
        )
      }
    }

    const title = `l1-foreign-${randomBytes(4).toString('hex')}`
    const foreignChild = startChild('xterm', ['-title', title, '-e', 'sleep', '600'])
    const foreignId = x('xdotool', ['search', '--sync', '--name', `^${title}$`]).split('\n')[0]
    if (!foreignId) {
      throw stationFailure('foreign-window', 'the xterm window never appeared')
    }
    const [displayWidth, displayHeight] = x('xdotool', ['getdisplaygeometry']).split(' ')
    x('xdotool', ['windowmove', foreignId, '0', '0'])
    x('xdotool', ['windowsize', foreignId, displayWidth, displayHeight])
    x('xdotool', ['windowactivate', '--sync', foreignId])
    const activeAtStart = activeWindowId()
    diag(`foreign id=${foreignId} active_at_start=${activeAtStart}`)
    if (activeAtStart !== foreignId) {
      throw stationFailure('foreign-active-start', `active ${activeAtStart}, wanted ${foreignId}`)
    }

    // Hold the foreign window in front, probing both Orca terminals throughout.
    const misses: string[] = []
    const holdStartedAt = Date.now()
    let round = 0
    while (Date.now() - holdStartedAt < FOREIGN_HOLD_MS) {
      round += 1
      for (const win of orcaWindows) {
        const ok = await probeDirectWriteOutput(win.page, win.ptyId, `L1_HOLD${round}_${win.label}`)
        diag(
          `hold round=${round} window=${win.label} painted=${ok} elapsed_ms=${Date.now() - startedAt}`
        )
        if (!ok) {
          misses.push(`round ${round} window ${win.label}`)
        }
      }
      await new Promise((resolve) => setTimeout(resolve, HOLD_PROBE_PAUSE_MS))
    }
    const activeAtEnd = activeWindowId()
    diag(`active_at_end=${activeAtEnd}`)
    if (activeAtEnd !== foreignId) {
      throw stationFailure('foreign-active-end', `active ${activeAtEnd}, wanted ${foreignId}`)
    }
    expect(
      misses,
      'L1 [USER_VISIBLE]: an Orca terminal stopped painting while a foreign X window was in front'
    ).toEqual([])

    // The foreign window goes away; each Orca window must still paint once focused again.
    if (foreignChild.pid !== undefined) {
      process.kill(foreignChild.pid, 'SIGTERM')
    }
    for (const win of orcaWindows) {
      await win.page.bringToFront()
      const ok = await probeDirectWriteOutput(win.page, win.ptyId, `L1_AFTER_${win.label}`)
      diag(`after window=${win.label} painted=${ok} elapsed_ms=${Date.now() - startedAt}`)
      expect(
        ok,
        `L1 [USER_VISIBLE]: window ${win.label} did not paint after the foreign window left`
      ).toBe(true)
    }
  } finally {
    for (const pid of spawnedPids) {
      try {
        process.kill(pid, 'SIGTERM')
      } catch {
        // already gone
      }
    }
  }
})

async function countOpenWindows(electronApp: ElectronApplication): Promise<number> {
  return electronApp.evaluate(
    ({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed()).length
  )
}
