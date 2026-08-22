import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree } from './helpers/store'
import { waitForActiveTerminalManager, waitForActivePanePtyId } from './helpers/terminal'

// Two rectangles and a populated menu prove nothing. These check that what the rail shows and does
// reaches real runtimes: a profile that launches, a split with its own PTY, and a resize the PTY
// actually took.

async function readActivePanePtyIds(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const state = window.__store?.getState()
    const tabId = state?.activeTabType === 'terminal' ? state.activeTabId : null
    const manager = tabId ? window.__paneManagers?.get(tabId) : null
    return (manager?.getPanes?.() ?? [])
      .map((pane) => pane.container?.dataset?.ptyId ?? '')
      .filter((ptyId) => ptyId.length > 0)
  })
}

/** Columns the PTY actually took, as reported by the main process — not the renderer's request. */
async function readAppliedPtyCols(page: Page, ptyId: string): Promise<number> {
  return page.evaluate(async (id) => (await window.api?.pty?.getSize?.(id))?.cols ?? 0, ptyId)
}

async function countTerminalTabs(page: Page): Promise<number> {
  return page.evaluate(() => {
    const state = window.__store?.getState()
    const worktreeId = state?.activeWorktreeId
    return worktreeId ? (state?.tabsByWorktree[worktreeId] ?? []).length : 0
  })
}

test.describe('@terminal-rail-reality', () => {
  test('the profile menu opens where it belongs and launches a real terminal', async ({
    orcaPage
  }) => {
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    const rail = orcaPage.locator('[data-terminal-rail]')
    await expect(rail).toBeVisible({ timeout: 30_000 })
    const toolbar = orcaPage.locator('[data-tab-group-strip-id] [data-terminal-panel-toolbar]')
    const before = await countTerminalTabs(orcaPage)

    await toolbar.locator('[data-terminal-toolbar-action="new-terminal-menu"]').click()
    const menuItems = orcaPage.locator('[role="menuitem"]')
    await expect(menuItems.first()).toBeVisible()

    // Every entry must name something. An empty row is what a menu built from a registry that
    // could not resolve its labels looks like, and it would still "render".
    for (const label of await menuItems.allTextContents()) {
      expect(label.trim().length).toBeGreaterThan(0)
    }
    // Within the window: a menu that opens off-screen is worse than one that does not open.
    const menuBox = await orcaPage.locator('[role="menu"]').first().boundingBox()
    const viewport = await orcaPage.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight
    }))
    expect(menuBox).not.toBeNull()
    expect(menuBox!.x).toBeGreaterThanOrEqual(0)
    expect(menuBox!.x + menuBox!.width).toBeLessThanOrEqual(viewport.width + 1)
    await orcaPage.screenshot({ path: 'pr-evidence/terminal-rail-profile-menu.png' })

    await menuItems.first().click()
    await expect.poll(async () => countTerminalTabs(orcaPage), { timeout: 30_000 }).toBe(before + 1)
    await expect(rail.locator('[data-terminal-rail-row-kind="tab"]')).toHaveCount(before + 1)
  })

  test('splitting from the rail creates a second real runtime', async ({ orcaPage }) => {
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    // Wait for the binding rather than assuming it: a pane exists before its PTY is attached, and
    // reading ids in that window reports zero runtimes for a terminal that is merely still starting.
    await waitForActivePanePtyId(orcaPage)
    const rail = orcaPage.locator('[data-terminal-rail]')
    await expect(rail).toBeVisible({ timeout: 30_000 })
    expect(await readActivePanePtyIds(orcaPage)).toHaveLength(1)

    await orcaPage
      .locator('[data-tab-group-strip-id] [data-terminal-toolbar-action="more"]')
      .click()
    await orcaPage.locator('[role="menuitem"]').first().click()

    // Distinct ids, not just two panes: a split that cloned the view would show two rectangles
    // driven by one runtime, which is the failure this is here to rule out.
    await expect
      .poll(async () => new Set(await readActivePanePtyIds(orcaPage)).size, { timeout: 30_000 })
      .toBe(2)
    await expect(rail.locator('[data-terminal-rail-row-kind="pane"]')).toHaveCount(2)
    await orcaPage.screenshot({ path: 'pr-evidence/terminal-rail-split.png' })
  })

  test('widening the rail narrows the PTY, not just the pixels', async ({ orcaPage }) => {
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    const ptyId = await waitForActivePanePtyId(orcaPage)
    await expect(orcaPage.locator('[data-terminal-rail]')).toBeVisible({ timeout: 30_000 })

    const narrowRailCols = await orcaPage
      .evaluate(() => window.__store?.getState().setTerminalRailWidth(140))
      .then(async () => {
        await orcaPage.waitForTimeout(800)
        return readAppliedPtyCols(orcaPage, ptyId)
      })
    expect(narrowRailCols).toBeGreaterThan(0)

    await orcaPage.evaluate(() => window.__store?.getState().setTerminalRailWidth(400))

    // The rail takes width from the terminal rather than covering it, so a wider rail must reach
    // the PTY. A visual resize whose PTY kept its old width is the column-desync bug in miniature.
    await expect
      .poll(async () => readAppliedPtyCols(orcaPage, ptyId), { timeout: 30_000 })
      .toBeLessThan(narrowRailCols)
  })
})
