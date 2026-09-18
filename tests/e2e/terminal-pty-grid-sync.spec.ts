import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import {
  ensureTerminalVisible,
  getAllWorktreeIds,
  switchToWorktree,
  waitForActiveWorktree,
  waitForSessionReady
} from './helpers/store'
import { waitForActivePanePtyId, waitForActiveTerminalManager } from './helpers/terminal'
import { waitForPtyShellEcho } from './terminal-pty-readiness'

/**
 * A TUI lays itself out for the PTY's grid; the pane shows xterm's grid. When ROWS differ, the
 * agent's footer (context bar, status line) is drawn below the visible area and cursor-up redraws
 * overwrite the wrong lines. terminal-column-desync-repro only compares columns.
 *
 * Oracle: after each stimulus the pane's xterm grid must converge to the grid the PTY applied
 * (pty:getSize, pinned to the applied size by that spec) within SETTLE_MS. Only a mismatch that
 * persists counts; a transient one during the reveal window is expected and self-heals.
 */
const SETTLE_MS = 5_000

type Grid = { xterm: string; pty: string }

async function readGrid(page: Page, ptyId: string): Promise<Grid> {
  return page.evaluate(async (id) => {
    let xterm = 'none'
    for (const manager of window.__paneManagers?.values() ?? []) {
      for (const pane of manager.getPanes?.() ?? []) {
        if (pane.container?.dataset?.ptyId === id) {
          xterm = `${pane.terminal?.cols}x${pane.terminal?.rows}`
        }
      }
    }
    const size = await window.api?.pty?.getSize?.(id)
    return { xterm, pty: size ? `${size.cols}x${size.rows}` : 'none' }
  }, ptyId)
}

async function expectGridConverges(page: Page, ptyId: string, label: string): Promise<void> {
  let last: Grid = { xterm: '?', pty: '?' }
  await expect
    .poll(
      async () => {
        last = await readGrid(page, ptyId)
        return last.xterm === last.pty
      },
      { timeout: SETTLE_MS, message: `${label}: xterm grid never matched the PTY grid` }
    )
    .toBe(true)
    .catch((error: Error) => {
      throw new Error(`${error.message} — last xterm=${last.xterm} pty=${last.pty}`)
    })
  console.log(`[grid-sync] ${label}: xterm=${last.xterm} pty=${last.pty}`)
}

async function setWindowBounds(
  app: ElectronApplication,
  bounds: { width: number; height: number }
): Promise<void> {
  const applied = await app.evaluate(async ({ BrowserWindow }, size) => {
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
    if (!win) {
      return 'no window'
    }
    if (win.isMinimized()) {
      win.restore()
    }
    // Why: unmaximize settles asynchronously and overrides a setSize issued before it lands.
    for (let i = 0; i < 40 && win.isMaximized(); i += 1) {
      win.unmaximize()
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    win.setSize(size.width, size.height)
    await new Promise((resolve) => setTimeout(resolve, 200))
    const [width, height] = win.getSize()
    return { width, height }
  }, bounds)
  // Why: Windows DPI scaling rounds the frame by a pixel or two.
  expect(applied, 'window size after setSize').not.toBe('no window')
  const size = applied as { width: number; height: number }
  expect(Math.abs(size.width - bounds.width), `width ${size.width}`).toBeLessThanOrEqual(4)
  expect(Math.abs(size.height - bounds.height), `height ${size.height}`).toBeLessThanOrEqual(4)
}

/** Proves the stimulus reached the pane: an unchanged grid means nothing was tested. */
async function expectGridChanged(
  page: Page,
  ptyId: string,
  from: Grid,
  label: string
): Promise<void> {
  await expect
    .poll(async () => (await readGrid(page, ptyId)).xterm, {
      timeout: SETTLE_MS,
      message: `${label}: the stimulus never changed the pane grid`
    })
    .not.toBe(from.xterm)
}

async function setUp(page: Page): Promise<string> {
  await waitForSessionReady(page)
  await waitForActiveWorktree(page)
  await page.evaluate(() => {
    const state = window.__store?.getState()
    state?.markFeatureTipsSeen(['orca-cli', 'cmd-j-palette', 'voice-dictation'])
  })
  await ensureTerminalVisible(page)
  await waitForActiveTerminalManager(page, 30_000)
  const ptyId = await waitForActivePanePtyId(page)
  await waitForPtyShellEcho(page, ptyId, 15_000)
  await expectGridConverges(page, ptyId, 'baseline')
  return ptyId
}

test.describe('terminal PTY grid sync (rows and cols) @headful', () => {
  test('grid re-syncs after the window height changes while the terminal is hidden', async ({
    orcaPage,
    electronApp
  }) => {
    test.setTimeout(180_000)
    const ptyId = await setUp(orcaPage)
    const home = await waitForActiveWorktree(orcaPage)
    const other = (await getAllWorktreeIds(orcaPage)).find((id) => id !== home)
    test.skip(!other, 'needs the seeded secondary worktree')
    const before = await readGrid(orcaPage, ptyId)
    await switchToWorktree(orcaPage, other!)
    await setWindowBounds(electronApp, { width: 1280, height: 560 })
    await orcaPage.waitForTimeout(500)
    await switchToWorktree(orcaPage, home)
    await ensureTerminalVisible(orcaPage)
    await expectGridChanged(orcaPage, ptyId, before, 'hidden height shrink')
    await expectGridConverges(orcaPage, ptyId, 'hidden height shrink')
  })

  test('grid re-syncs after the right sidebar toggles and the window resizes', async ({
    orcaPage,
    electronApp
  }) => {
    test.setTimeout(180_000)
    const ptyId = await setUp(orcaPage)
    for (const open of [true, false]) {
      await orcaPage.evaluate(
        (value) => window.__store?.getState().setRightSidebarOpen(value),
        open
      )
      await expectGridConverges(orcaPage, ptyId, `right sidebar ${open ? 'open' : 'closed'}`)
    }
    const before = await readGrid(orcaPage, ptyId)
    await setWindowBounds(electronApp, { width: 1100, height: 700 })
    await expectGridChanged(orcaPage, ptyId, before, 'visible resize')
    await expectGridConverges(orcaPage, ptyId, 'visible resize')
  })

  test('grid re-syncs after the window is minimized, resized and restored', async ({
    orcaPage,
    electronApp
  }) => {
    test.setTimeout(180_000)
    const ptyId = await setUp(orcaPage)
    await setWindowBounds(electronApp, { width: 1280, height: 800 })
    await expectGridConverges(orcaPage, ptyId, 'unmaximized baseline')
    const before = await readGrid(orcaPage, ptyId)
    await electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()
        .find((w) => !w.isDestroyed())
        ?.minimize()
    })
    await orcaPage.waitForTimeout(800)
    // Why: Windows discards a setSize issued while minimized, so resize in the instant after
    // restore, while the pane may still believe it is hidden.
    const restored = await electronApp.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
      win?.restore()
      win?.setSize(1000, 620)
      await new Promise((resolve) => setTimeout(resolve, 300))
      return win ? win.getSize().join('x') : 'no window'
    })
    console.log(`[grid-sync] restored window size: ${restored}`)
    await expectGridChanged(orcaPage, ptyId, before, 'minimize → resize → restore')
    await expectGridConverges(orcaPage, ptyId, 'minimize → resize → restore')
  })
})
