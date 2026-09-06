/**
 * Captures the workspace chrome in each state this convergence changed.
 *
 * Numeric geometry assertions carry the contract; these images carry what numbers cannot — whether
 * the composition actually reads as a rail beside a panel beside a workspace, at both extremes of
 * the sidebar's range and with a live terminal in the centre.
 *
 * Evidence, not the contract. Nothing here asserts a pixel, because a screenshot gate would either
 * duplicate the geometry specs or start failing on font rendering. Tagged so it can be skipped in
 * CI and run deliberately when the corpus is wanted.
 */

import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { getStoreState } from './helpers/store'

const CORPUS_DIR = path.resolve(process.cwd(), '_logs', 'visual-corpus')

async function shoot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: path.join(CORPUS_DIR, `${name}.png`) })
}

async function applyState(page: Page, next: Record<string, unknown>): Promise<void> {
  await page.evaluate((state) => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }
    const actions = store.getState()
    if (typeof state.sidebarOpen === 'boolean') {
      actions.setSidebarOpen(state.sidebarOpen)
    }
    if (typeof state.rightSidebarOpen === 'boolean') {
      actions.setRightSidebarOpen(state.rightSidebarOpen)
    }
    if (typeof state.sidebarWidth === 'number') {
      actions.setSidebarWidth(state.sidebarWidth)
    }
  }, next)
}

test('@visual-corpus captures the workspace chrome in each converged state', async ({
  sharedPage
}) => {
  test.setTimeout(240_000)

  const rail = sharedPage.locator('[data-workspace-activity-rail]')
  await expect(rail).toBeVisible({ timeout: 60_000 })
  await expect(sharedPage.locator('.xterm').first()).toBeVisible({ timeout: 60_000 })

  // The panel holding the left region, which is the default composition.
  await applyState(sharedPage, { rightSidebarOpen: true, sidebarOpen: true })
  await shoot(sharedPage, '01-panel-files')

  // Projects: the panel yields and the project sidebar takes the region.
  await applyState(sharedPage, { rightSidebarOpen: false, sidebarWidth: 300 })
  await expect(sharedPage.locator('[data-contextual-tour-target="sidebar-navigation"]')).toBeVisible(
    { timeout: 20_000 }
  )
  await shoot(sharedPage, '02-projects')

  // Both extremes of the sidebar's range, so the corpus shows the layout under stress.
  await applyState(sharedPage, { sidebarWidth: 220 })
  await shoot(sharedPage, '03-sidebar-narrow')
  await applyState(sharedPage, { sidebarWidth: 500 })
  await shoot(sharedPage, '04-sidebar-wide')
  await applyState(sharedPage, { sidebarWidth: 300 })

  // Icon-only collapse, then the restoration — the pair is the point, not either alone.
  await applyState(sharedPage, { sidebarOpen: false })
  await expect(rail).toBeVisible()
  await shoot(sharedPage, '05-icon-only-collapsed')
  await applyState(sharedPage, { sidebarOpen: true })
  await shoot(sharedPage, '06-re-expanded')

  // Each application surface the rail owns, captured through the rail itself.
  for (const activity of ['tasks', 'automations', 'workspace'] as const) {
    const entry = sharedPage.locator(`[data-workspace-activity="${activity}"]`)
    if ((await entry.count()) === 0) {
      continue
    }
    await entry.click()
    await expect
      .poll(async () => getStoreState<string>(sharedPage, 'activeView'), { timeout: 20_000 })
      .toBe(activity)
    await shoot(sharedPage, `07-activity-${activity}`)
  }

  // Back to the workspace, and hold the drag open so the terminal is captured mid-resize rather
  // than after it settles — the state a still image otherwise never shows.
  await sharedPage.evaluate(() => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }
    store.getState().setActiveView('terminal')
  })
  await expect(sharedPage.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })

  const handle = sharedPage.locator('[data-sidebar-resize-handle]')
  const box = await handle.boundingBox()
  if (box) {
    await sharedPage.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await sharedPage.mouse.down()
    await sharedPage.mouse.move(box.x + box.width / 2 + 90, box.y + box.height / 2)
    await shoot(sharedPage, '08-terminal-during-resize')
    await sharedPage.mouse.up()
  }
  await shoot(sharedPage, '09-terminal-after-resize')
})
