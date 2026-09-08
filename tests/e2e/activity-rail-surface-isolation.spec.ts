/**
 * The activity rail exists in the running app, and using it does not disturb the session.
 *
 * Two claims that only a real launch can settle. First that the rail renders at all: it lives
 * inside the left-docked side panel's icon strip, so a geometry or dock regression would remove it
 * from the window while every unit test still passed. Second — the one that matters — that
 * selecting an application surface is a presentation change: the terminal it replaces must still
 * be the same runtime when you come back, not a fresh one that merely looks the same.
 *
 * Locale-independent: entries are addressed by data attribute, because their accessible names are
 * translated and asserting English text passes in one locale and silently stops matching in others.
 */

import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { getStoreState } from './helpers/store'

/** Tab ids per worktree — the renderer's handle on the live terminal sessions. */
async function readTabIdentity(page: Page): Promise<string> {
  const tabs = await getStoreState<Record<string, { id: string }[]>>(page, 'tabsByWorktree')
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(tabs ?? {}).map(([worktreeId, list]) => [
        worktreeId,
        (list ?? []).map((tab) => tab.id)
      ])
    )
  )
}

test('the rail switches surfaces without replacing the terminal session', async ({
  sharedPage
}) => {
  test.setTimeout(180_000)

  // Arrange — the fixture leaves a bound worktree with its terminal open.
  await expect(sharedPage.locator('[data-workspace-activity-rail]')).toBeVisible({
    timeout: 60_000
  })
  await expect(sharedPage.locator('[data-workspace-activity="automations"]')).toBeVisible()
  await expect(sharedPage.locator('[data-workspace-activity-tasks]')).toBeVisible()

  // The migrated rows must not also still be in the sidebar — that would be duplicate chrome.
  expect(await sharedPage.locator('[data-contextual-tour-target="sidebar-tasks"]').count()).toBe(0)

  await expect
    .poll(async () => getStoreState<string>(sharedPage, 'activeView'), { timeout: 30_000 })
    .toBe('terminal')
  const before = await readTabIdentity(sharedPage)
  expect(before, 'the fixture must leave a live terminal to protect').not.toBe('{}')

  // Act — leave the workspace through the rail, then come back the way the surface closes.
  await sharedPage.locator('[data-workspace-activity="automations"]').click()
  await expect
    .poll(async () => getStoreState<string>(sharedPage, 'activeView'), { timeout: 20_000 })
    .toBe('automations')
  await expect(sharedPage.locator('.xterm')).not.toBeVisible({ timeout: 20_000 })

  // The rail has to survive its own use. Every surface it offers is a full-page view, and those
  // unmount the side panel the rail is hosted in — so arriving somewhere by the rail used to leave
  // no rail to leave by. Asserted here because this spec previously navigated back through the
  // page's own close action, which is exactly the path that hides the problem.
  await expect(
    sharedPage.locator('[data-workspace-activity-rail]'),
    'the rail disappeared on the surface it navigated to'
  ).toBeVisible()
  await expect(sharedPage.locator('[data-workspace-activity="workspace"]')).toBeVisible()

  // The side panel is Explorer and Source Control. It used to be unmounted on every application
  // surface, so arriving at Automations from a project window took those with it — the rail could
  // bring you back to the workspace, but nothing here could tell you what was in it. Suppression is
  // keyed on whether a project is open, not on which view is showing, so with one bound they stay.
  await expect(
    sharedPage.locator('[data-activity-bar-item="explorer"]'),
    'Explorer left the window when the application surface opened'
  ).toBeVisible()
  await expect(sharedPage.locator('[data-activity-bar-item="source-control"]')).toBeVisible()

  await sharedPage.evaluate(() => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }
    store.getState().closeAutomationsPage()
  })
  await expect
    .poll(async () => getStoreState<string>(sharedPage, 'activeView'), { timeout: 20_000 })
    .toBe('terminal')

  // Assert — same sessions, not merely a terminal-shaped surface.
  await expect(sharedPage.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })
  expect(await readTabIdentity(sharedPage)).toBe(before)
})
