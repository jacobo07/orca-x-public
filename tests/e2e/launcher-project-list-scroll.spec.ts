import { expect, test } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'
import {
  LAUNCHER_SCROLL_FIXTURE_PROJECT_COUNT,
  measureLauncherProjectList,
  seedLauncherProjectEstate,
  wheelOverLauncherProjectList
} from './helpers/launcher-project-list-scroll'

/**
 * Every project in the launcher must be reachable by ordinary wheel scrolling.
 *
 * The surface is pinned to the viewport, so a list longer than the window can only be read if
 * something along the chain owns the overflow. Nothing asserts that by construction, and the
 * control that expands the list to its full length sits at the top — so once it has been used on
 * a large estate it can leave the reader stranded, with the control that would undo it scrolled
 * out of reach along with the rows.
 *
 * Why the fixture is this large: the defect is a function of the list outgrowing the window, so a
 * handful of rows cannot express it. At this count the list exceeds any plausible window height,
 * which is what makes the assertion able to fail at all.
 */

test.use({ seedTestRepo: false })

test('every launcher project row is reachable by wheel scrolling', async ({ orcaPage }) => {
  await waitForSessionReady(orcaPage)
  await seedLauncherProjectEstate(orcaPage)

  // "View all" is what takes the list past the window. Reading the list folded would measure the
  // one state that never overflows and would pass on both sides of the fix.
  const viewAll = orcaPage.locator('button', { hasText: /View all \(\d+\)/ })
  await expect(viewAll).toBeVisible({ timeout: 15_000 })
  await viewAll.click()

  const expanded = await measureLauncherProjectList(orcaPage)
  expect(
    expanded.rowCount,
    'the list did not expand to the full estate, so this run never reproduced the overflow'
  ).toBe(LAUNCHER_SCROLL_FIXTURE_PROJECT_COUNT)
  expect(
    expanded.contentExceedsViewport,
    `the estate fit inside the window (${expanded.viewportHeight}px), so nothing was clipped to reach`
  ).toBe(true)

  await wheelOverLauncherProjectList(orcaPage)

  const scrolled = await measureLauncherProjectList(orcaPage)
  console.log(`[launcher-scroll] ${JSON.stringify(scrolled)}`)

  expect(
    scrolled.lastRowFullyVisible,
    `after scrolling, the last project ("${scrolled.lastRowLabel}") sits at ` +
      `top=${scrolled.lastRowTop} bottom=${scrolled.lastRowBottom} in a ${scrolled.viewportHeight}px ` +
      `window. Scroll owner: ${scrolled.scrollOwner ?? 'none — no ancestor of the list scrolls'}.`
  ).toBe(true)
})
