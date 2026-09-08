/**
 * Minimizing while an application surface is open, then coming back, must return a live terminal.
 *
 * This is the crossing point of the two failures Orca treats separately, and it is the one path
 * neither of their gates covers. Navigation (closed) proves the workbench survives switching to
 * Automations; the minimize gates prove work and pixels survive a window transition while the
 * terminal is the thing on screen. Nobody had tested them together, and the composition is not
 * implied by either half: with an application surface showing, the terminal pane is not visible, so
 * `useTerminalWindowWakeRecovery` returns before installing any listener and the window-wake
 * recovery that normally runs on restore is simply absent. Whether the terminal is current when the
 * user comes back then rests entirely on the tab-visibility resume that the Explorer click triggers
 * — a different path, with different triggers, that no test drives after a real minimize.
 *
 * The assertions read as one user journey: work started, user left it for an application page,
 * minimized the window, came back, returned to the workspace. At the end the same session must be
 * there (navigation's guarantee), it must have advanced while all that happened (execution's), and
 * it must be painting (presentation's).
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { runNodeScriptInTerminal } from './helpers/run-node-script-in-terminal'
import {
  ensureTerminalVisible,
  getStoreState,
  waitForActiveWorktree,
  waitForSessionReady
} from './helpers/store'
import {
  getTerminalContent,
  waitForActiveTerminalManager,
  waitForPaneIdentitySnapshot
} from './helpers/terminal'
import {
  screenshotTerminalSurface,
  scrollingTerminalWorkload
} from './helpers/terminal-presentation-witness'

const MINIMIZED_HOLD_MS = Number(process.env.ORCA_E2E_SURFACE_HOLD_MS) || 20_000
/** Settle window for the resume path the Explorer click triggers (refit, WebGL reattach, present). */
const RETURN_SETTLE_MS = 4_000
const MARKER = 'ORCA-SURFACE'

/** Tab ids per worktree — the renderer's handle on the live terminal sessions. */
async function readTabIdentity(page: Page): Promise<string> {
  const tabs = await getStoreState<Record<string, { id: string }[]>>(page, 'tabsByWorktree')
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(tabs ?? {}).map(([worktreeId, list]) => [
        worktreeId,
        (list ?? []).map((tab) => tab.id)
      ])
    )
  )
}

// @headful because a headless window has no window manager to honour minimize(): the call no-ops,
// and a check standing on the permissive side of that gap reports the same answer for both worlds.
test('work survives a minimize taken from an application surface @headful', async ({
  orcaPage,
  electronApp
}) => {
  test.setTimeout(MINIMIZED_HOLD_MS + 240_000)

  // Arrange — a live terminal, and the identity that says "the same session" later.
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage)
  const paneSnapshot = await waitForPaneIdentitySnapshot(orcaPage, 1)
  const ptyId = paneSnapshot.panes[0]?.ptyId
  expect(ptyId, 'the fixture must leave a live PTY to measure').toBeTruthy()

  const tabsBefore = await readTabIdentity(orcaPage)
  expect(tabsBefore, 'the fixture must leave a live terminal to return to').not.toBe('{}')

  const runDir = path.join(tmpdir(), `orca-surface-minimize-${randomUUID()}`)
  mkdirSync(runDir, { recursive: true })
  const staged = await runNodeScriptInTerminal(
    orcaPage,
    ptyId as string,
    scrollingTerminalWorkload(MARKER),
    { dir: runDir, prefix: 'orca-surface-minimize' }
  )

  try {
    // Precondition — the workload is running and reaching the terminal before we leave it.
    await expect
      .poll(async () => (await getTerminalContent(orcaPage)).includes(`${MARKER}-`), {
        timeout: 30_000,
        message: 'the workload never reached the terminal — setup failure, not a product result'
      })
      .toBe(true)

    // Act — leave the workspace for an application surface, the way the user does.
    await orcaPage.locator('[data-workspace-activity="automations"]').click()
    await expect
      .poll(async () => getStoreState<string>(orcaPage, 'activeView'), { timeout: 20_000 })
      .toBe('automations')
    const modelOnLeaving = await getTerminalContent(orcaPage)

    // Act — minimize from there, hold, come back.
    await electronApp.evaluate(({ BrowserWindow }) => {
      const [window] = BrowserWindow.getAllWindows()
      window?.minimize()
    })
    const reallyMinimized = await electronApp.evaluate(({ BrowserWindow }) => {
      const [window] = BrowserWindow.getAllWindows()
      return window?.isMinimized() ?? false
    })
    test.skip(
      !reallyMinimized,
      'window manager refused the programmatic minimize — inconclusive, not a pass'
    )

    await new Promise((resolve) => setTimeout(resolve, MINIMIZED_HOLD_MS))

    await electronApp.evaluate(({ BrowserWindow }) => {
      const [window] = BrowserWindow.getAllWindows()
      window?.restore()
      window?.focus()
    })
    await expect
      .poll(
        async () =>
          electronApp.evaluate(({ BrowserWindow }) => {
            const [window] = BrowserWindow.getAllWindows()
            return window?.isMinimized() ?? true
          }),
        { timeout: 20_000, message: 'the window never left the minimized state' }
      )
      .toBe(false)

    // The application surface must still be usable after the restore — the route back is on it.
    await expect(
      orcaPage.locator('[data-activity-bar-item="explorer"]'),
      'Explorer was not reachable on the application surface after the window came back'
    ).toBeVisible({ timeout: 20_000 })

    // Act — the route back to work.
    await orcaPage.locator('[data-activity-bar-item="explorer"]').click()
    await expect
      .poll(async () => getStoreState<string>(orcaPage, 'activeView'), {
        timeout: 20_000,
        message: 'Explorer did not return the content area to the workspace'
      })
      .toBe('terminal')
    await expect(orcaPage.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })
    await new Promise((resolve) => setTimeout(resolve, RETURN_SETTLE_MS))

    // Assert — the same session, not a reconstruction that merely looks like one.
    expect(
      await readTabIdentity(orcaPage),
      'the terminal sessions changed identity across the application surface and minimize'
    ).toBe(tabsBefore)

    // Assert — it kept working through the surface change and the minimize.
    expect(
      await getTerminalContent(orcaPage),
      'the terminal produced no new output across an application surface plus a minimize — work stopped somewhere behind the UI'
    ).not.toBe(modelOnLeaving)

    // Assert — and it is painting now, not showing a frozen picture of itself. Two samples with the
    // workload running: a live surface turns over, a stale one repeats.
    const firstFrame = await screenshotTerminalSurface(orcaPage)
    expect(
      firstFrame,
      'the terminal surface could not be measured after the return — setup failure'
    ).not.toBeNull()
    await new Promise((resolve) => setTimeout(resolve, RETURN_SETTLE_MS))
    const secondFrame = await screenshotTerminalSurface(orcaPage)
    expect(
      secondFrame,
      'the terminal surface could not be measured after the return — setup failure'
    ).not.toBeNull()
    expect(
      secondFrame?.equals(firstFrame as Buffer),
      'the returned terminal is not painting: its model is advancing but the surface is repeating the same frame'
    ).toBe(false)
  } finally {
    staged.cleanup()
    rmSync(runDir, { recursive: true, force: true })
  }
})
