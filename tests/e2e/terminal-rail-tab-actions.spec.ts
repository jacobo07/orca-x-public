import { expect, test } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

/**
 * The rail can do what the tab strip can, not just navigate to what it shows.
 *
 * This is the prerequisite for the strip ever giving up terminal navigation: rename, colour, pin
 * and the close family live only on the tab, so a rail without them is a strict subset and
 * consolidating onto it would remove features rather than duplication.
 */

const RAIL_TAB_ROW = '[data-terminal-rail-row-kind="tab"]'
const RENAME_ITEM = '[data-tab-menu-action="rename"]'
const RENAME_INPUT = '[data-terminal-rail-rename-input="true"]'

test('the rail row offers the tab context menu and can rename a terminal', async ({ orcaPage }) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)

  const row = orcaPage.locator(RAIL_TAB_ROW).first()
  await expect(row).toBeVisible({ timeout: 30_000 })
  const originalTitle = (await row.textContent())?.trim() ?? ''

  await row.click({ button: 'right' })

  // The menu is the tab strip's own, so proving one action reaches it proves the wiring.
  const renameItem = orcaPage.locator(RENAME_ITEM)
  await expect(renameItem).toBeVisible({ timeout: 10_000 })
  await expect(orcaPage.locator('[data-tab-menu-action="toggle-pin"]')).toBeVisible()

  await renameItem.click()

  const input = orcaPage.locator(RENAME_INPUT)
  await expect(input).toBeVisible({ timeout: 10_000 })
  await input.fill('Renombrado desde el rail')
  await input.press('Enter')

  await expect(orcaPage.locator(RAIL_TAB_ROW).first()).toContainText('Renombrado desde el rail', {
    timeout: 10_000
  })
  expect(originalTitle).not.toContain('Renombrado desde el rail')
})

test('Escape during a rail rename discards the edit', async ({ orcaPage }) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)

  const row = orcaPage.locator(RAIL_TAB_ROW).first()
  await expect(row).toBeVisible({ timeout: 30_000 })
  const before = (await row.textContent())?.trim() ?? ''

  await row.click({ button: 'right' })
  await orcaPage.locator(RENAME_ITEM).click()

  const input = orcaPage.locator(RENAME_INPUT)
  await expect(input).toBeVisible({ timeout: 10_000 })
  await input.fill('no deberia quedar')
  await input.press('Escape')

  // Why this matters: the input commits on blur, and Escape unmounts it. Without a resolved-once
  // guard the blur would write back the edit the user just discarded.
  await expect(orcaPage.locator(RAIL_TAB_ROW).first()).not.toContainText('no deberia quedar', {
    timeout: 10_000
  })
  await expect(orcaPage.locator(RAIL_TAB_ROW).first()).toContainText(before, { timeout: 10_000 })
})
