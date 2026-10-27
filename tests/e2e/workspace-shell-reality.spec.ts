import type { Page } from '@stablyai/playwright-test'
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

/** Screenshots taken mid-transition showed a faded popover and a tab underline still sliding. */
async function settleAnimations(page: Page): Promise<void> {
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
        .map((animation) => animation.finished.catch(() => undefined))
    )
  )
}

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

    const agentsTab = page.getByTestId('workspace-tab-agents')
    await agentsTab.dispatchEvent('mousedown')
    await expect(agentsTab).toHaveAttribute('data-state', 'active')
    const running = page.getByTestId('workspace-running-session')
    await expect(running).toHaveCount(1)
    await expect(running).toHaveAttribute('data-pane-key', pane.paneKey)
    await expect(running).toHaveAttribute('data-liveness', 'working')
    await settleAnimations(page)
    await page.screenshot({ path: testInfo.outputPath('workspace-agents.png') })

    const projectsTab = page.getByTestId('workspace-tab-projects')
    await projectsTab.dispatchEvent('mousedown')
    await expect(projectsTab).toHaveAttribute('data-state', 'active')
    const projectCount = await page.evaluate(() => window.__store!.getState().projects.length)
    expect(projectCount).toBeGreaterThan(0)
    await expect(page.getByTestId('workspace-project')).toHaveCount(projectCount)
    await settleAnimations(page)
    await page.screenshot({ path: testInfo.outputPath('workspace-projects.png') })

    await page.getByTestId('workspace-new-agent').click()
    await page.getByTestId('new-agent-project').click()
    const projectList = page.getByTestId('new-agent-project-list')
    await expect(projectList).toBeVisible()
    await expect(page.getByTestId('new-agent-project-option')).toHaveCount(projectCount)
    expect(await page.getByTestId('new-agent-dialog').locator('select').count()).toBe(0)
    await settleAnimations(page)
    await page.screenshot({ path: testInfo.outputPath('workspace-project-picker.png') })
    // One Escape per layer: the popover's layer stays registered until its exit animation ends.
    await page.keyboard.press('Escape')
    await expect(projectList).toHaveCount(0)

    // The defect was a light native list in a dark window: the list must be dark in dark mode.
    await page.evaluate(() => window.__store!.getState().updateSettingsOrThrow({ theme: 'dark' }))
    await expect
      .poll(() => page.evaluate(() => document.documentElement.classList.contains('dark')))
      .toBe(true)
    await page.getByTestId('new-agent-project').click()
    await expect(projectList).toBeVisible()
    await settleAnimations(page)
    const darkPaint = await projectList.evaluate((list) => {
      // Canvas resolves any CSS color space (tokens may be oklch) to sRGB bytes.
      const context = document.createElement('canvas').getContext('2d')!
      context.fillStyle = getComputedStyle(list).backgroundColor
      context.fillRect(0, 0, 1, 1)
      const [r, g, b] = context.getImageData(0, 0, 1, 1).data
      return {
        colorScheme: getComputedStyle(document.documentElement).colorScheme,
        luminance: (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
      }
    })
    expect(darkPaint.colorScheme).toBe('dark')
    expect(darkPaint.luminance).toBeLessThan(0.3)
    await page.screenshot({ path: testInfo.outputPath('workspace-project-picker-dark.png') })
    await page.keyboard.press('Escape')
    await expect(projectList).toHaveCount(0)
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
