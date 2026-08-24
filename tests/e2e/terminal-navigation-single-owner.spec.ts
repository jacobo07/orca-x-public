import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

/**
 * Exactly one terminal navigator is visible at a time, and no terminal is ever unreachable.
 *
 * The rail lists panes as well as tabs, so it is the richer surface and owns terminal navigation
 * while it is on screen. Collapsing it must hand the job back to the tab row rather than leaving
 * the user with no way to switch terminals.
 */

const SORTABLE_TAB = '[data-testid="sortable-tab"]'
const RAIL = '[data-terminal-rail=""]'
const COLLAPSE_BUTTON = '[data-terminal-toolbar-action="collapse"]'

async function countTerminalTabsInStrip(page: Page): Promise<number> {
  return page.locator(SORTABLE_TAB).count()
}

test('the rail and the tab row never both navigate terminals', async ({ orcaPage }) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)

  const rail = orcaPage.locator(RAIL).first()
  await expect(rail).toBeVisible({ timeout: 30_000 })

  // Rail visible: it owns navigation, so the strip shows no terminal tabs.
  await expect
    .poll(async () => countTerminalTabsInStrip(orcaPage), {
      timeout: 15_000,
      message: 'terminal tabs should be absent from the strip while the rail is visible'
    })
    .toBe(0)

  const railRowCount = await rail.getByRole('button').count()
  expect(railRowCount, 'the rail must list the terminals it took ownership of').toBeGreaterThan(0)

  // Collapsing the rail must return the tabs, or the terminals become unreachable.
  await orcaPage.locator(COLLAPSE_BUTTON).first().click()
  await expect(rail).toHaveCount(0)
  await expect
    .poll(async () => countTerminalTabsInStrip(orcaPage), {
      timeout: 15_000,
      message: 'collapsing the rail must hand terminal navigation back to the tab row'
    })
    .toBeGreaterThan(0)

  // And back again, so the two surfaces stay mutually exclusive rather than one-way.
  await orcaPage.locator(COLLAPSE_BUTTON).first().click()
  await expect(rail).toBeVisible()
  await expect
    .poll(async () => countTerminalTabsInStrip(orcaPage), { timeout: 15_000 })
    .toBe(0)
})
