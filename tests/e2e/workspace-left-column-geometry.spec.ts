import { expect, test } from './helpers/orca-app'
import { measureWorkspaceColumns } from './helpers/workspace-layout-geometry'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

/**
 * The left column must not reserve width no surface paints.
 *
 * The column is an auto-width flex column holding the titlebar header and the sidebar, so it
 * takes whichever is wider. When the header wins, the difference becomes a tall empty band
 * between the sidebar and the workbench — white in light mode, and a large black block in dark.
 */

test('left column reserves no unpainted width', async ({ orcaPage }) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)

  // The strip collapses itself when it does not fit, and that decision is measured on a
  // ResizeObserver, so read geometry only once it has stopped moving.
  await expect
    .poll(
      async () => (await measureWorkspaceColumns(orcaPage)).projectSidebar?.width ?? null,
      { timeout: 20_000, message: 'project sidebar never rendered' }
    )
    .not.toBeNull()
  await orcaPage.waitForTimeout(2000)

  const geometry = await measureWorkspaceColumns(orcaPage)
  console.log(`[left-column] ${JSON.stringify(geometry)}`)

  expect(geometry.projectSidebar).not.toBeNull()
  expect(geometry.workbench).not.toBeNull()

  // 1px of tolerance for the column's own border; anything more is unowned geometry.
  expect(
    geometry.gapPx,
    `sidebar right edge ${geometry.projectSidebar?.right} to workbench left edge ${geometry.workbench?.left}; ` +
      `left header is ${geometry.leftHeader?.width}px wide, sidebar is ${geometry.projectSidebar?.width}px`
  ).toBeLessThanOrEqual(1)

  // The header is now the sidebar's width, so a strip that does not fit collapses to the compact
  // button. Constraining the column must not cost a menu: one of the two has to be present.
  expect(
    geometry.menuStripLabels.length > 0 || geometry.compactMenuButtonPresent,
    `neither the menu strip (${geometry.menuStripLabels.length} labels) nor the compact menu button is present`
  ).toBe(true)
})
