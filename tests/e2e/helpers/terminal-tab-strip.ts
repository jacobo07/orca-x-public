import type { Page } from '@stablyai/playwright-test'
import { expect } from '@stablyai/playwright-test'

// Why: an expanded terminal rail owns terminal tab navigation, so strip tabs render only while it is collapsed.
export async function showTerminalTabStrip(page: Page): Promise<void> {
  const railCollapsed = () =>
    page.evaluate(() => window.__store?.getState().terminalRailCollapsed === true)
  if (!(await railCollapsed())) {
    // Why :visible: other workspaces keep their terminal panels mounted but hidden.
    await page.locator('[data-terminal-toolbar-action="collapse"]:visible').first().click()
  }
  await expect.poll(railCollapsed, { timeout: 5_000 }).toBe(true)
}
