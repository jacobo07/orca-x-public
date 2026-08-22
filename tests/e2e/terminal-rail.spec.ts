import { expect, test } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree } from './helpers/store'
import { splitActiveTerminalPane, waitForPaneCount } from './helpers/terminal'

// The rail is a claim about the running app, not about a component: that a user looking at a
// terminal can see which terminals exist, make another one, and split — without hunting for an
// 18px glyph orphaned over the canvas. Source review cannot see any of that.

test.describe('@terminal-rail', () => {
  test('the terminal panel header carries the toolbar', async ({ orcaPage }) => {
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)

    await expect(orcaPage.locator('[data-terminal-rail]')).toBeVisible({ timeout: 30_000 })
    // Inside the header strip, not merely somewhere on the page: the placement is the claim.
    const toolbar = orcaPage.locator(
      '[data-tab-group-strip-id] [data-terminal-panel-toolbar]'
    )
    await expect(toolbar).toBeVisible()

    // Each control is asserted separately: a toolbar that renders but whose primary action is
    // missing is the failure mode worth naming, and a single "toolbar exists" check hides it.
    await expect(toolbar.locator('[data-terminal-toolbar-action="new-terminal"]')).toBeVisible()
    await expect(
      toolbar.locator('[data-terminal-toolbar-action="new-terminal-menu"]')
    ).toBeVisible()
    await expect(toolbar.locator('[data-terminal-toolbar-action="more"]')).toBeVisible()
    await expect(toolbar.locator('[data-terminal-toolbar-action="collapse"]')).toBeVisible()
  })

  test('collapsing the rail leaves the toolbar that can bring it back', async ({ orcaPage }) => {
    // The reason the toolbar left the rail. While it lived inside, collapsing hid the only control
    // that reopens it, so the rail could be dismissed into a state with no way out but a keybinding.
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)

    const rail = orcaPage.locator('[data-terminal-rail]')
    await expect(rail).toBeVisible({ timeout: 30_000 })
    const collapse = orcaPage.locator(
      '[data-tab-group-strip-id] [data-terminal-toolbar-action="collapse"]'
    )

    await collapse.click()
    await expect(rail).toHaveCount(0)
    await expect(collapse).toBeVisible()

    await collapse.click()
    await expect(rail).toBeVisible()
  })

  test('the rail lists the real terminal tabs and marks the active one', async ({ orcaPage }) => {
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)

    const rail = orcaPage.locator('[data-terminal-rail]')
    await expect(rail).toBeVisible({ timeout: 30_000 })

    // Against the store, not a fixed number: the rail's promise is that it mirrors the tabs the app
    // actually has, so the expectation must not re-declare that list either.
    const terminalTabIds = await orcaPage.evaluate(() => {
      const state = window.__store?.getState()
      const worktreeId = state?.activeWorktreeId
      if (!state || !worktreeId) {
        return []
      }
      // tabsByWorktree holds terminal tabs only; with a single tab group it is exactly what the
      // rail lists, which is the arrangement this spec sets up.
      return (state.tabsByWorktree[worktreeId] ?? []).map((tab: { id: string }) => tab.id)
    })
    expect(terminalTabIds.length).toBeGreaterThan(0)

    const rows = rail.locator('[data-terminal-rail-row-kind="tab"]')
    await expect(rows).toHaveCount(terminalTabIds.length)
    await expect(rail.locator('[data-terminal-rail-row][data-active]')).toHaveCount(1)
  })

  test('a split tab shows its panes as rows under the tab', async ({ orcaPage }) => {
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)

    const rail = orcaPage.locator('[data-terminal-rail]')
    await expect(rail).toBeVisible({ timeout: 30_000 })
    // A single pane is the whole tab, so it earns no child row — rows appear only once the tab
    // genuinely contains more than one runtime.
    await expect(rail.locator('[data-terminal-rail-row-kind="pane"]')).toHaveCount(0)

    await splitActiveTerminalPane(orcaPage)
    await waitForPaneCount(orcaPage, 2)

    await expect(rail.locator('[data-terminal-rail-row-kind="pane"]')).toHaveCount(2)
  })

  test('split is not a lone control floating over the terminal canvas', async ({ orcaPage }) => {
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await expect(orcaPage.locator('[data-terminal-rail]')).toBeVisible({ timeout: 30_000 })

    // The reported defect, pinned as placement rather than as a label: an 18px split button was the
    // only thing inside the titleless overlay strip painted across the top of the terminal — no
    // surrounding chrome, nothing to read it against. Asserting on the label would pin the wrong
    // property (and break in every locale); what must not come back is a control living alone in a
    // bar that shows nothing else. A titled pane header may still carry its own actions.
    const orphanedOverlayControls = await orcaPage.evaluate(() =>
      [...document.querySelectorAll('.pane-title-bar')]
        .filter((bar) => (bar.textContent ?? '').trim() === '')
        .reduce((total, bar) => total + bar.querySelectorAll('button').length, 0)
    )
    expect(orphanedOverlayControls).toBe(0)
  })
})
