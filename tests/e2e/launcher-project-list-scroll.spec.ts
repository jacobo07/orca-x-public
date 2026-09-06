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

  // The list shows the whole estate up front, so it overflows with nothing expanded first.
  // Guarded rather than assumed: a list that quietly went back to folding would fit the window,
  // and a test measuring a list that fits cannot fail whatever the scrolling does.
  const listed = await measureLauncherProjectList(orcaPage)
  expect(
    listed.rowCount,
    'the list did not show the full estate, so this run never reproduced the overflow'
  ).toBe(LAUNCHER_SCROLL_FIXTURE_PROJECT_COUNT)
  expect(
    listed.contentExceedsViewport,
    `the estate fit inside the window (${listed.viewportHeight}px), so nothing was clipped to reach`
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

test('the landing list filters instead of folding', async ({ orcaPage }) => {
  // Both project surfaces list the same rows, but only one of them could search them, and the one
  // that could not folded at five rows instead. The fold is what put a large estate behind a
  // control, and the control is only there because the list had no other way to stay short.
  // Searching makes it short on purpose, so the fold has nothing left to do.
  await waitForSessionReady(orcaPage)
  await seedLauncherProjectEstate(orcaPage)

  await expect(orcaPage.locator('button', { hasText: /View all \(\d+\)/ })).toHaveCount(0)
  await expect(orcaPage.locator('button', { hasText: 'Show fewer' })).toHaveCount(0)

  const filter = orcaPage.getByLabel('Filter projects by name or path')
  await expect(filter).toBeVisible()

  // Every row is listed up front now, so the filter is the thing that has to narrow them.
  expect((await measureLauncherProjectList(orcaPage)).rowCount).toBe(
    LAUNCHER_SCROLL_FIXTURE_PROJECT_COUNT
  )

  await filter.fill('Estate Project 42')
  await expect
    .poll(async () => (await measureLauncherProjectList(orcaPage)).rowCount, {
      message: 'the filter never narrowed the list'
    })
    .toBe(1)
  expect((await measureLauncherProjectList(orcaPage)).lastRowLabel).toBe('Estate Project 42')
})
