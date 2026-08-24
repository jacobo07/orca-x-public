import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

/**
 * Docked left, project navigation and the file panel are alternatives, not neighbours.
 *
 * Before this they stacked: an activity bar, the Explorer panel and the project sidebar all held
 * the left edge at once, leaving the terminal about a third of the window. They are the same
 * spatial role, so the activity bar switches between them instead of showing both.
 */

const PROJECT_SIDEBAR = '[data-native-file-drop-target="project-sidebar"]'
const EXPLORER_PANEL = '[data-orca-explorer-shell="true"]'
const PROJECTS_SWITCH = '[data-left-nav-switch="projects"]'

async function visibleCount(page: Page, selector: string): Promise<number> {
  return page.locator(selector).filter({ visible: true }).count()
}

test('the left region shows one navigation surface at a time', async ({ orcaPage }) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)

  const projectsSwitch = orcaPage.locator(PROJECTS_SWITCH)
  await expect(projectsSwitch).toBeVisible({ timeout: 30_000 })

  // Start on Projects, whatever the profile restored.
  await projectsSwitch.click()
  await expect
    .poll(async () => visibleCount(orcaPage, PROJECT_SIDEBAR), { timeout: 15_000 })
    .toBe(1)
  expect(
    await visibleCount(orcaPage, EXPLORER_PANEL),
    'the file panel must yield the left region to projects'
  ).toBe(0)
  await expect(projectsSwitch).toHaveAttribute('aria-pressed', 'true')

  // Switching to a panel view takes the region back.
  const explorerButton = orcaPage.locator('[data-activity-bar-item="explorer"]')
  await explorerButton.first().click()
  await expect
    .poll(async () => visibleCount(orcaPage, EXPLORER_PANEL), { timeout: 15_000 })
    .toBe(1)
  expect(
    await visibleCount(orcaPage, PROJECT_SIDEBAR),
    'projects must yield the left region to the file panel'
  ).toBe(0)
  await expect(projectsSwitch).toHaveAttribute('aria-pressed', 'false')

  // And back, so neither surface is a one-way trip.
  await projectsSwitch.click()
  await expect
    .poll(async () => visibleCount(orcaPage, PROJECT_SIDEBAR), { timeout: 15_000 })
    .toBe(1)
  expect(await visibleCount(orcaPage, EXPLORER_PANEL)).toBe(0)
})
