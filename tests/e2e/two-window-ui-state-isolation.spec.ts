/**
 * Two project windows keep their own layout.
 *
 * The persisted UI blob is profile-global and every window re-hydrates from it whenever any window
 * writes, which makes that file a live channel between windows rather than only a restore point.
 * That is right for a preference and wrong for geometry: a window's width and whether its panel is
 * open describe the window you are looking at, not a setting you changed everywhere.
 *
 * The distinction survives because the seed and the broadcast are separated, not because sharing was
 * removed — a newly opened window still starts from the last values, so the preference still travels
 * where it is useful and stops where it would reach across a boundary.
 *
 * Store-level tests cannot settle this. The leak lives in the round trip through main, so it needs
 * two real renderers.
 */

import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { getStoreState } from './helpers/store'

type Layout = { sidebarWidth: number; rightSidebarWidth: number; rightSidebarOpen: boolean }

async function setLayout(page: Page, layout: Layout): Promise<void> {
  await page.evaluate((next) => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }
    store.getState().setSidebarWidth(next.sidebarWidth)
    store.getState().setRightSidebarWidth(next.rightSidebarWidth)
    store.getState().setRightSidebarOpen(next.rightSidebarOpen)
  }, layout)
  await expect.poll(async () => getStoreState<number>(page, 'sidebarWidth')).toBe(layout.sidebarWidth)
}

async function readLayout(page: Page): Promise<Layout> {
  return {
    sidebarWidth: await getStoreState<number>(page, 'sidebarWidth'),
    rightSidebarWidth: await getStoreState<number>(page, 'rightSidebarWidth'),
    rightSidebarOpen: await getStoreState<boolean>(page, 'rightSidebarOpen')
  }
}

test('a second window keeps its own sidebar width and panel state', async ({
  sharedPage,
  electronApp
}) => {
  test.setTimeout(240_000)

  await expect(sharedPage.locator('[data-workspace-activity-rail]')).toBeVisible({ timeout: 60_000 })
  const firstLayout: Layout = { sidebarWidth: 300, rightSidebarWidth: 340, rightSidebarOpen: true }
  await setLayout(sharedPage, firstLayout)

  // Wait for the write to reach the durable blob before opening the second window. Without this the
  // new window reads the file before the debounced save lands, comes up on the default, and the
  // "it inherits the preference" assertion fails for a reason that has nothing to do with scoping.
  await expect
    .poll(
      async () =>
        sharedPage.evaluate(async () => (await window.api.ui.get())?.sidebarWidth ?? null),
      { timeout: 30_000 }
    )
    .toBe(300)

  // Open a second real window rather than a second store: the round trip through main is the whole
  // subject, and an in-process store never makes that trip.
  const secondWindow = await Promise.all([
    electronApp.waitForEvent('window', { timeout: 60_000 }),
    sharedPage.evaluate(() => window.api.ui.createWindow())
  ]).then(([page]) => page)

  await secondWindow.waitForLoadState('domcontentloaded')
  await expect
    .poll(async () => getStoreState<boolean>(secondWindow, 'persistedUIReady'), { timeout: 60_000 })
    .toBe(true)

  try {
    // The second window starts from the shared preference — that part is intended and is what makes
    // this a scoping question rather than an argument for removing the sharing.
    expect(
      await getStoreState<number>(secondWindow, 'sidebarWidth'),
      'a new window should open at the last width the user chose'
    ).toBe(300)

    // Act — give the second window a layout of its own.
    const secondLayout: Layout = {
      sidebarWidth: 420,
      rightSidebarWidth: 300,
      rightSidebarOpen: false
    }
    await setLayout(secondWindow, secondLayout)

    // Long enough for the 150ms debounced write, the durable save and the broadcast back out.
    await sharedPage.waitForTimeout(2_000)

    const firstAfter = await readLayout(sharedPage)
    expect(
      firstAfter.sidebarWidth,
      'resizing the second window resized the first one'
    ).toBe(firstLayout.sidebarWidth)
    expect(
      firstAfter.rightSidebarWidth,
      'resizing the panel in the second window resized it in the first one'
    ).toBe(firstLayout.rightSidebarWidth)
    expect(
      firstAfter.rightSidebarOpen,
      'collapsing the panel in the second window collapsed it in the first one'
    ).toBe(true)

    // And the second window keeps what it was given, rather than being pulled back by the first.
    expect(await getStoreState<number>(secondWindow, 'sidebarWidth')).toBe(420)
    expect(await getStoreState<boolean>(secondWindow, 'rightSidebarOpen')).toBe(false)
  } finally {
    await secondWindow.close()
  }
})
