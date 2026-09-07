/**
 * Two project windows each own their application menu.
 *
 * The chrome IPC channels are registered once for the process, and each window binds and unbinds its
 * own entry in a sender-keyed map. That shape exists because of a specific previous failure: handlers
 * registered per window made `ipcMain.handle` throw on the second window, and a teardown that removed
 * the channels outright unbound the survivor's titlebar the moment the other window closed.
 *
 * So the property under test is ownership, not rendering. A window whose sender has no entry gets an
 * empty menu back — which is exactly what a stolen or revoked binding looks like from the renderer,
 * and exactly what the strip would render as the compact fallback without anything else going wrong.
 *
 * Store-level tests cannot settle this. The binding lives in the round trip through main, so it needs
 * two real renderers.
 */

import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { getStoreState } from './helpers/store'

/** The top-level menu this window's own sender binding resolves to. */
async function menuLabelsFor(page: Page): Promise<string[]> {
  const items = await page.evaluate(() => window.api.ui.getMenuTopLevelItems())
  return items.map((item) => item.label)
}

/** What this window's titlebar actually draws. */
async function stripLabelsFor(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('button.titlebar-menu-strip-button')].map(
      (button) => button.textContent?.trim() ?? ''
    )
  )
}

test('a second window neither steals nor revokes the first window menu', async ({
  sharedPage,
  electronApp
}) => {
  test.skip(process.platform === 'darwin', 'macOS keeps its native menu bar')
  test.setTimeout(240_000)

  await expect(sharedPage.locator('[data-workspace-activity-rail]')).toBeVisible({ timeout: 60_000 })

  const firstBefore = await menuLabelsFor(sharedPage)
  expect(firstBefore.length, 'the first window registered no application menu').toBeGreaterThan(0)

  // Act — a second real window. An in-process store never makes the trip through main, which is
  // where the binding this test is about lives.
  const secondWindow = await Promise.all([
    electronApp.waitForEvent('window', { timeout: 60_000 }),
    sharedPage.evaluate(() => window.api.ui.createWindow())
  ]).then(([page]) => page)

  await secondWindow.waitForLoadState('domcontentloaded')
  await expect
    .poll(async () => getStoreState<boolean>(secondWindow, 'persistedUIReady'), { timeout: 60_000 })
    .toBe(true)

  try {
    // Both windows resolve the menu through their own binding. Registering the second must not have
    // thrown, and must not have replaced the first window's entry.
    expect(await menuLabelsFor(secondWindow), 'the second window has no menu of its own').toEqual(
      firstBefore
    )
    expect(
      await menuLabelsFor(sharedPage),
      'opening a second window took the first window menu'
    ).toEqual(firstBefore)

    // And both draw it, which is the user-visible half.
    await expect.poll(async () => stripLabelsFor(secondWindow), { timeout: 30_000 }).toEqual(
      firstBefore
    )
    await expect.poll(async () => stripLabelsFor(sharedPage), { timeout: 30_000 }).toEqual(
      firstBefore
    )

    await secondWindow.screenshot({ path: 'pr-evidence/two-window-menu-second.png' })
    await sharedPage.screenshot({ path: 'pr-evidence/two-window-menu-first.png' })
  } finally {
    await secondWindow.close()
  }

  // The survivor keeps its own binding. This is the regression the sender-keyed map exists for: a
  // teardown that removed the channels for the process would leave this window's titlebar inert
  // while everything else about it still worked.
  await expect
    .poll(async () => menuLabelsFor(sharedPage), { timeout: 30_000 })
    .toEqual(firstBefore)
  await expect
    .poll(async () => stripLabelsFor(sharedPage), { timeout: 30_000 })
    .toEqual(firstBefore)

  await sharedPage.screenshot({ path: 'pr-evidence/two-window-menu-after-close.png' })
})
