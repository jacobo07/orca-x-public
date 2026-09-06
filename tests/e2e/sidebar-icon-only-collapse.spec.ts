/**
 * Collapsing the left navigation leaves an icon rail, not an empty edge.
 *
 * The distinction the product contract draws is between collapsed and hidden: collapsed keeps the
 * way back on screen, hidden does not. Docked left (the default) the panel's icon strip is the
 * window's own edge and is meant to survive, so this asserts the composed result rather than any
 * one component's parameters — the strip stays, the project content goes, the centre takes the
 * width, and the rail is still usable afterwards.
 */

import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { getStoreState } from './helpers/store'

async function setSidebarOpen(page: Page, open: boolean): Promise<void> {
  await page.evaluate((next) => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }
    store.getState().setSidebarOpen(next)
  }, open)
  await expect.poll(async () => getStoreState<boolean>(page, 'sidebarOpen')).toBe(open)
}

test('collapsing the sidebar keeps the activity rail and gives the width to the centre', async ({
  sharedPage
}) => {
  test.setTimeout(180_000)

  const rail = sharedPage.locator('[data-workspace-activity-rail]')
  // Addressed by data hook rather than accessible name: the label is translated, so an English
  // selector passes on an English host and silently stops matching everywhere else.
  const search = sharedPage.locator('[data-contextual-tour-target="sidebar-navigation"]')

  await expect(rail).toBeVisible({ timeout: 60_000 })

  // Docked left the panel and the project sidebar are alternatives, so the panel has to yield
  // before Projects is the left surface at all (resolveEffectiveSidebarOpen).
  // Measured on this fixture: sidebarOpen true, rightSidebarOpen true, dock left — so the panel
  // holds the left surface until it is told to yield.
  await sharedPage.evaluate(() => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }
    store.getState().setRightSidebarOpen(false)
  })
  await setSidebarOpen(sharedPage, true)
  await expect(search).toBeVisible({ timeout: 20_000 })

  const railBoxExpanded = await rail.boundingBox()
  const centre = sharedPage.locator('.xterm').first()
  await expect(centre).toBeVisible({ timeout: 30_000 })
  const centreExpanded = await centre.boundingBox()

  // Act — collapse.
  await setSidebarOpen(sharedPage, false)

  // The project content goes...
  await expect(search).toBeHidden({ timeout: 20_000 })
  // ...the rail stays, at the same width, still on the window's edge.
  await expect(rail).toBeVisible()
  const railBoxCollapsed = await rail.boundingBox()
  expect(railBoxCollapsed?.width).toBe(railBoxExpanded?.width)

  // ...and the centre reclaims the space rather than leaving an unpainted band.
  await expect
    .poll(async () => (await centre.boundingBox())?.width ?? 0, { timeout: 20_000 })
    .toBeGreaterThan(centreExpanded?.width ?? 0)

  // The rail is still usable while collapsed — otherwise this is hidden, not collapsed.
  await expect(sharedPage.locator('[data-workspace-activity="automations"]')).toBeVisible()

  // Restore, so the surface comes back rather than staying gone.
  await setSidebarOpen(sharedPage, true)
  await expect(search).toBeVisible({ timeout: 20_000 })
})
