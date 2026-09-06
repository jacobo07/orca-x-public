/**
 * Drives and measures the launcher's project list at an estate size that overflows the window.
 *
 * The measurement deliberately stops at the product observable — can the reader get to the last
 * project — rather than at a CSS property. A surface can carry the right overflow declaration and
 * still strand the reader if an ancestor centres it, and it can carry none and still be readable
 * if something above it scrolls, so the declaration answers the wrong question.
 */

import { expect, type Page } from '@stablyai/playwright-test'

/**
 * Enough projects to exceed any plausible window height.
 *
 * The estate this was built for runs to dozens of projects, which is the point at which the list
 * outgrew the surface. A fixture small enough to fit cannot fail the assertion it exists for.
 */
export const LAUNCHER_SCROLL_FIXTURE_PROJECT_COUNT = 60

export type LauncherProjectListMeasurement = {
  rowCount: number
  viewportHeight: number
  /** True while some part of the list lies outside the window, in either direction. */
  contentExceedsViewport: boolean
  lastRowLabel: string
  lastRowTop: number
  lastRowBottom: number
  lastRowFullyVisible: boolean
  /**
   * The label at each end, read from the DOM rather than assumed from the seed.
   *
   * Persisted UI state can still re-order the rows after the seed has settled, so a test that
   * names the project it expects at an end asserts something the fixture does not control. The
   * ends are what navigation is about; which project occupies them is not.
   */
  firstRowLabel: string
  /** The nearest ancestor that actually scrolls, described for the failure message. */
  scrollOwner: string | null
  listCenterX: number
  listCenterY: number
}

/**
 * Puts the window in the no-workspace state with a large project estate.
 *
 * Seeded through the store rather than by adding real repositories: this measures how a long list
 * lays out, and paying Git for sixty checkouts would buy nothing the layout can tell apart.
 */
export async function seedLauncherProjectEstate(page: Page): Promise<void> {
  await applyLauncherProjectEstate(page)

  // Wait for the rows, not for a particular order. Persisted UI state syncs in after session
  // readiness and carries its own recent-project order, so the order is not the fixture's to
  // decide. An earlier version re-applied the seed until the order matched, which turned a
  // settling surface into a permanently re-rendering one and left Playwright waiting on an
  // element that never stopped moving. What the tests need is the whole estate present.
  await expect
    .poll(
      async () =>
        page.evaluate(() => document.querySelectorAll('button[data-launcher-project-row]').length),
      { timeout: 15_000, message: 'the seeded project estate never finished rendering' }
    )
    .toBe(LAUNCHER_SCROLL_FIXTURE_PROJECT_COUNT)
}

async function applyLauncherProjectEstate(page: Page): Promise<void> {
  await page.evaluate((count) => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available — is the app in dev mode?')
    }

    const repos = Array.from({ length: count }, (_, index) => {
      const ordinal = String(index + 1).padStart(2, '0')
      return {
        id: `estate-${ordinal}`,
        displayName: `Estate Project ${ordinal}`,
        path: `/home/user/Cursor Projects/Estate Project ${ordinal}`,
        addedAt: index
      }
    })

    store.setState({
      repos,
      projects: [],
      recentProjectIds: repos.map((repo) => repo.id),
      worktreesByRepo: Object.fromEntries(
        repos.map((repo) => [repo.id, [{ id: `${repo.id}-main`, isMainWorktree: true }]])
      ),
      // The launcher only stands in for a workspace while none is bound.
      activeWorktreeId: null,
      activeView: 'terminal'
    })
  }, LAUNCHER_SCROLL_FIXTURE_PROJECT_COUNT)
}

/**
 * The project row holding keyboard focus, and whether it can actually be seen.
 *
 * Both halves matter together: focus that has moved to a row scrolled out of the window is the
 * shape of keyboard navigation that reads, to the person using it, as focus having vanished.
 */
export async function focusedProjectRow(
  page: Page
): Promise<{ index: number; label: string | null; fullyVisible: boolean }> {
  return page.evaluate(() => {
    const rows = [...document.querySelectorAll('button[data-launcher-project-row]')]
    const active = document.activeElement
    const index = rows.indexOf(active as Element)
    if (index === -1 || !(active instanceof HTMLButtonElement)) {
      return { index: -1, label: null, fullyVisible: false }
    }
    const rect = active.getBoundingClientRect()
    return {
      index,
      label: active.querySelector('span')?.textContent?.trim() ?? '',
      fullyVisible: rect.top >= 0 && rect.bottom <= window.innerHeight
    }
  })
}

/** Reads the rendered list. Throws rather than returning zeroes if the list is not on screen. */
export async function measureLauncherProjectList(
  page: Page
): Promise<LauncherProjectListMeasurement> {
  return page.evaluate(() => {
    const heading = [...document.querySelectorAll('span')].find(
      (element) => element.textContent?.trim() === 'Recent projects'
    )
    if (!heading) {
      throw new Error('The recent-project list is not rendered')
    }
    const list = heading.closest('div.space-y-1')
    const rowsContainer = list?.querySelector('div.flex.flex-col')
    if (!list || !rowsContainer) {
      throw new Error('The recent-project list rendered in an unexpected shape')
    }

    const rows = [...rowsContainer.querySelectorAll('button')]
    const lastRow = rows.at(-1)
    if (!lastRow) {
      throw new Error('The recent-project list rendered no rows')
    }

    // The owner is whichever ancestor can actually move, not whichever one declares an intent to.
    let scrollOwner: string | null = null
    for (let node = list.parentElement; node; node = node.parentElement) {
      const overflowY = getComputedStyle(node).overflowY
      const scrolls = overflowY === 'auto' || overflowY === 'scroll'
      if (scrolls && node.scrollHeight > node.clientHeight + 1) {
        scrollOwner = `${node.tagName.toLowerCase()}.${node.className
          .toString()
          .split(/\s+/)
          .slice(0, 3)
          .join('.')} (scrollHeight ${node.scrollHeight} > clientHeight ${node.clientHeight})`
        break
      }
    }

    const listRect = list.getBoundingClientRect()
    const lastRect = lastRow.getBoundingClientRect()
    const viewportHeight = window.innerHeight

    return {
      rowCount: rows.length,
      viewportHeight,
      contentExceedsViewport: listRect.bottom > viewportHeight || listRect.top < 0,
      firstRowLabel: rows[0]?.querySelector('span')?.textContent?.trim() ?? '',
      lastRowLabel: lastRow.querySelector('span')?.textContent?.trim() ?? '',
      lastRowTop: Math.round(lastRect.top),
      lastRowBottom: Math.round(lastRect.bottom),
      lastRowFullyVisible: lastRect.top >= 0 && lastRect.bottom <= viewportHeight,
      scrollOwner,
      listCenterX: Math.round(listRect.left + listRect.width / 2),
      listCenterY: Math.round(Math.min(Math.max(listRect.top + 40, 40), viewportHeight - 40))
    }
  })
}

/**
 * Scrolls the wheel over the list until the last row is readable, or until it is clear that
 * turning the wheel does not move it.
 *
 * Stops early on success so a passing run stays quick, and stops on a stalled position so a
 * failing run reports the defect rather than a timeout.
 */
export async function wheelOverLauncherProjectList(page: Page, maxSteps = 40): Promise<void> {
  let previousTop: number | null = null
  let stalledSteps = 0

  for (let step = 0; step < maxSteps; step += 1) {
    const measurement = await measureLauncherProjectList(page)
    if (measurement.lastRowFullyVisible) {
      return
    }
    if (previousTop !== null && measurement.lastRowTop === previousTop) {
      stalledSteps += 1
      // Three identical positions after three wheel gestures is the wheel doing nothing.
      if (stalledSteps >= 3) {
        return
      }
    } else {
      stalledSteps = 0
    }
    previousTop = measurement.lastRowTop

    await page.mouse.move(measurement.listCenterX, measurement.listCenterY)
    await page.mouse.wheel(0, 400)
    await page.waitForTimeout(60)
  }
}
