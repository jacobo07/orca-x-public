import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree } from './helpers/store'

/**
 * The application menu is structural Workspace chrome: the top-level entries are the user's command
 * map, and the map is not allowed to disappear because of what is open inside the window.
 *
 * Presence is the property under test, not availability. An individual command may be enabled,
 * disabled or absent according to real state — that is the registered menu's business. What must
 * hold here is that every top-level menu Orca registered has its own affordance in the titlebar of
 * a workspace window, in every legitimate workspace state.
 *
 * Why a running app: presence is decided by a width measurement, and the unit environment cannot lay
 * anything out — every box is 0x0 there, so the collapse path reports "fits" unconditionally and a
 * green suite says nothing about this.
 *
 * Why each test asserts its own precondition first: the workspace has two left-region layouts, and
 * the seeded fixture starts in the one where the project sidebar has yielded to the file panel. A
 * spec that does not pin which layout it is in silently measures the other one and passes without
 * ever observing the state it names.
 */

/** The registered top-level labels, read from the menu Electron actually built. */
async function registeredMenuLabels(page: Page): Promise<string[]> {
  const items = await page.evaluate(() => window.api.ui.getMenuTopLevelItems())
  expect(items.length, 'Orca registered no application menu at all').toBeGreaterThan(0)
  return items.map((item) => item.label)
}

/** What the titlebar currently offers, plus the measurements that decide it. */
async function titlebarMenuState(page: Page): Promise<{
  labels: string[]
  headerWidth: number
  stripWidth: number
  fallbackPresent: boolean
  floating: boolean
  headerFound: boolean
}> {
  return page.evaluate(() => {
    const header = document.querySelector('.titlebar-left')
    const strip = [...document.querySelectorAll('button.titlebar-menu-strip-button')]
    return {
      labels: strip.map((button) => button.textContent?.trim() ?? ''),
      headerWidth: header?.clientWidth ?? 0,
      stripWidth: (strip[0]?.parentElement as HTMLElement | undefined)?.scrollWidth ?? 0,
      // Structural, not by label: the compact fallback is the header's only titlebar-icon-button
      // (the sidebar toggle carries its own class), and matching its localized aria-label reported a
      // false "absent" the first time this ran on a Spanish host.
      fallbackPresent: (header?.querySelectorAll('button.titlebar-icon-button').length ?? 0) > 0,
      floating: Boolean(document.querySelector('.titlebar-left-floating')),
      headerFound: Boolean(header)
    }
  })
}

/**
 * Reach the workspace layout where the project sidebar owns the left region.
 *
 * Docked left, the file panel and the project sidebar are alternatives — the panel takes the region
 * and the sidebar yields — so opening the sidebar is not enough on its own.
 */
async function ensureProjectSidebarOwnsLeftRegion(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = window.__store?.getState()
    state?.setSidebarWidth(280)
    if (state?.sidePanelDock === 'left' && state.rightSidebarOpen) {
      state.toggleRightSidebar()
    }
    if (state && !state.sidebarOpen) {
      state.toggleSidebar()
    }
  })
}

test.describe('@workspace-menu-presence', () => {
  test.skip(process.platform === 'darwin', 'macOS keeps its native menu bar')

  test('a project-bound workspace shows every registered menu with the sidebar open', async ({
    orcaPage
  }) => {
    // Arrange — the reported state: a project open, a terminal in it, the project sidebar owning the
    // left region at its default width. Nothing widened.
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await ensureProjectSidebarOwnsLeftRegion(orcaPage)

    // Precondition, asserted separately so a fixture that could not reach this layout is never
    // reported as the product losing its menu.
    await expect
      .poll(async () => {
        const state = await titlebarMenuState(orcaPage)
        return state.headerFound && !state.floating
      })
      .toBe(true)

    // Act
    const registered = await registeredMenuLabels(orcaPage)
    const state = await titlebarMenuState(orcaPage)

    // Assert — one affordance per registered menu. The measurements ride along so a failure says
    // which gate fired rather than only that the labels were missing.
    expect(
      state.labels,
      `sidebar-owned header ${state.headerWidth}px, strip ${state.stripWidth}px, ` +
        `fallback ${state.fallbackPresent ? 'shown' : 'absent'}`
    ).toEqual(registered)

    await orcaPage.screenshot({ path: 'pr-evidence/workspace-menu-presence-sidebar-open.png' })
  })

  test('the menu survives the file panel taking the left region', async ({ orcaPage }) => {
    // The other legitimate left-region layout: the panel owns it and the project sidebar yields, so
    // the titlebar header floats over the tab strip. Different geometry, same command map.
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await orcaPage.evaluate(() => {
      const state = window.__store?.getState()
      state?.setSidebarWidth(280)
      state?.setSidePanelDock('left')
      if (state && !state.rightSidebarOpen) {
        state.toggleRightSidebar()
      }
    })

    await expect.poll(async () => (await titlebarMenuState(orcaPage)).floating).toBe(true)

    const registered = await registeredMenuLabels(orcaPage)
    const state = await titlebarMenuState(orcaPage)

    expect(
      state.labels,
      `floating header ${state.headerWidth}px, strip ${state.stripWidth}px`
    ).toEqual(registered)

    await orcaPage.screenshot({ path: 'pr-evidence/workspace-menu-presence-panel-owns-left.png' })
  })

  test('collapsing the project sidebar does not remove the menu', async ({ orcaPage }) => {
    // Collapsed is a legitimate workspace state and nothing about it makes a command map redundant.
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await orcaPage.evaluate(() => {
      const state = window.__store?.getState()
      state?.setSidebarWidth(280)
      if (state?.sidePanelDock === 'left' && state.rightSidebarOpen) {
        state.toggleRightSidebar()
      }
      if (state?.sidebarOpen) {
        state.toggleSidebar()
      }
    })

    await expect.poll(async () => (await titlebarMenuState(orcaPage)).floating).toBe(true)

    const registered = await registeredMenuLabels(orcaPage)
    const state = await titlebarMenuState(orcaPage)

    expect(
      state.labels,
      `collapsed header ${state.headerWidth}px, strip ${state.stripWidth}px`
    ).toEqual(registered)

    await orcaPage.screenshot({ path: 'pr-evidence/workspace-menu-presence-collapsed.png' })
  })
})
