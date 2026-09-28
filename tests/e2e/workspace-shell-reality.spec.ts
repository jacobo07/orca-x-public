import { emitCodexHookStatus, readHookEndpoint } from './helpers/agent-hook-endpoint'
import { expect, test } from './helpers/orca-app'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'
import { waitForActivePaneHookDescriptor } from './helpers/terminal'

// PRODUCT REALITY — Workspace owns its shell, leads back out, and shows the real estate.
//
// Measured defects this pins (spec §12): the worktree list and the Explorer side panel stayed
// beside Workspace; nothing led back out; a terminal agent reported by its own hook never appeared;
// the Projects tab was empty while Terminals had projects; the project picker was a native select.
// The running session is driven through the app's real hook listener, not the store.

test.setTimeout(300_000)

// Rendered only while the worktree sidebar is mounted and open (`.worktree-sidebar-scrollbar` is CSS-only).
const WORKTREE_LIST = '[data-sidebar-resize-handle]'
const SIDE_PANEL = '[data-side-panel-content]'

test('Workspace owns its shell and shows the running agent and the project estate', async ({
  testRepoPath
}, testInfo) => {
  const session = createRestartSession(testInfo)
  try {
    const { app, page } = await session.launch()
    await attachRepoAndOpenTerminal(page, testRepoPath)
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(1440, 900)
    })
    // Docked left, an open side panel replaces the worktree list; close it (it stays mounted).
    await page.evaluate(() => {
      window.__store!.getState().setRightSidebarOpen(false)
      window.__store!.getState().setSidebarOpen(true)
    })
    // Positive controls: in Terminals both are mounted, so their absence below means something.
    await expect(page.locator(WORKTREE_LIST).first()).toBeAttached()
    await expect(page.locator(SIDE_PANEL).first()).toBeAttached()

    // A terminal agent reports itself through the real hook endpoint.
    const pane = await waitForActivePaneHookDescriptor(page)
    await emitCodexHookStatus(await readHookEndpoint(app), {
      paneKey: pane.paneKey,
      worktreeId: pane.worktreeId,
      state: 'working',
      prompt: 'reconcile the ledger'
    })

    await page.locator('[data-workspace-activity="agent-workspace"]').first().click()
    await expect(page.getByTestId('workspace-roster')).toBeVisible()
    await expect(page.locator(WORKTREE_LIST)).toHaveCount(0)
    await expect(page.locator(SIDE_PANEL)).toHaveCount(0)

    await page.getByTestId('workspace-tab-agents').dispatchEvent('mousedown')
    const running = page.getByTestId('workspace-running-session')
    await expect(running).toHaveCount(1)
    await expect(running).toHaveAttribute('data-pane-key', pane.paneKey)
    await expect(running).toHaveAttribute('data-liveness', 'working')
    await page.screenshot({ path: testInfo.outputPath('workspace-agents.png') })

    await page.getByTestId('workspace-tab-projects').dispatchEvent('mousedown')
    const projectCount = await page.evaluate(() => window.__store!.getState().projects.length)
    expect(projectCount).toBeGreaterThan(0)
    await expect(page.getByTestId('workspace-project')).toHaveCount(projectCount)
    await page.screenshot({ path: testInfo.outputPath('workspace-projects.png') })

    await page.getByTestId('workspace-new-agent').click()
    await page.getByTestId('new-agent-project').click()
    await expect(page.getByTestId('new-agent-project-option')).toHaveCount(projectCount)
    expect(await page.getByTestId('new-agent-dialog').locator('select').count()).toBe(0)
    await page.screenshot({ path: testInfo.outputPath('workspace-project-picker.png') })
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('new-agent-dialog')).toHaveCount(0)

    // Back returns to Terminals, where the worktree list comes back.
    await page.getByTestId('workspace-exit').click()
    await expect(page.getByTestId('workspace-roster')).toHaveCount(0)
    await expect(page.locator(WORKTREE_LIST).first()).toBeAttached()
    expect(await page.evaluate(() => window.__store!.getState().activeView)).toBe('terminal')
  } finally {
    await session.dispose()
  }
})
