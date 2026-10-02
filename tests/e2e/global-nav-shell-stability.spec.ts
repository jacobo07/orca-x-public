/**
 * One global navigation on every route (docs/reference/workspace-convergence.md §2.1).
 *
 * The defect this guards: entering Workspace replaced the left navigation with a 40px rail that
 * returned null in some dock layouts, so the global options shrank or vanished per route. Here the
 * destination list and the column's width are read on each major view and compared with the
 * terminal view's — a route that drops, adds or reorders an entry, or resizes the column, is red.
 *
 * Entries are addressed by data hooks, never by translated names.
 */

import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { getStoreState } from './helpers/store'

type NavReading = { items: string[]; width: number; navCount: number }

async function readNav(page: Page): Promise<NavReading> {
  return page.evaluate(() => {
    const navs = [...document.querySelectorAll<HTMLElement>('[data-global-nav]')].filter(
      (nav) => nav.getBoundingClientRect().width > 0
    )
    const nav = navs[0]
    return {
      navCount: navs.length,
      width: nav ? Math.round(nav.getBoundingClientRect().width) : 0,
      items: nav
        ? [...nav.querySelectorAll('[data-global-nav-item]')].map(
            (node) => node.getAttribute('data-global-nav-item') ?? ''
          )
        : []
    }
  })
}

async function showView(page: Page, view: string): Promise<void> {
  await page.evaluate((target) => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }
    store.getState().setActiveView(target as never)
  }, view)
  await expect.poll(async () => getStoreState<string>(page, 'activeView')).toBe(view)
  // One frame for the route's layout to commit before it is measured.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))))
}

const ROUTES = [
  'conversations',
  'resumeCenter',
  'backlog',
  'workstation',
  'automations',
  'tasks',
  'settings'
]

// Resume Center's own destinations (resume-center.full.desktop.at-rest.r01); Back is a control.
const RESUME_CENTER_ITEMS = [
  'home',
  'cognitive-workspace',
  'projects',
  'agents',
  'tasks',
  'knowledge',
  'runtime',
  'audit',
  'settings'
]

test('every major route keeps the same global navigation', async ({ sharedPage }) => {
  test.setTimeout(180_000)

  await expect(sharedPage.locator('[data-global-nav]')).toBeVisible({ timeout: 60_000 })
  await showView(sharedPage, 'terminal')
  const baseline = await readNav(sharedPage)

  // Floor and positive control: the instrument found the column and its fixed entries, so an
  // empty reading on a later route cannot pass as "equal".
  expect(baseline.navCount).toBe(1)
  expect(baseline.items.length).toBeGreaterThanOrEqual(5)
  expect(baseline.items).toEqual(expect.arrayContaining(['home', 'agent-workspace', 'settings']))
  expect(baseline.width).toBeGreaterThan(40)

  for (const view of ROUTES) {
    await showView(sharedPage, view)
    const reading = await readNav(sharedPage)
    expect(reading.navCount, `${view}: global navigation columns`).toBe(1)
    // The one exception (Owner, 2026-10-02): Resume Center swaps the destinations, never the column.
    const resume = view === 'resumeCenter'
    expect(reading.items, `${view}: destination list`).toEqual(
      resume ? RESUME_CENTER_ITEMS : baseline.items
    )
    await expect(sharedPage.locator('[data-global-nav]')).toHaveAttribute(
      'data-global-nav-variant',
      resume ? 'resume-center' : 'global'
    )
    expect(reading.width, `${view}: column width`).toBe(baseline.width)
  }

  // No second copy of a destination anywhere in the window (the old strip/column relocation).
  expect(
    await sharedPage.locator('[data-workspace-activity="agent-workspace"]').count(),
    'Workspace entry drawn more than once'
  ).toBe(1)

  await showView(sharedPage, 'terminal')
})

test('collapsing is a person’s choice that every route then honours', async ({ sharedPage }) => {
  test.setTimeout(180_000)

  await expect(sharedPage.locator('[data-global-nav]')).toBeVisible({ timeout: 60_000 })
  await showView(sharedPage, 'terminal')
  const expanded = await readNav(sharedPage)

  await sharedPage.locator('[data-global-nav-control="toggle"]').click()
  await expect(sharedPage.locator('[data-global-nav]')).toHaveAttribute(
    'data-global-nav-collapsed',
    'true'
  )
  const collapsed = await readNav(sharedPage)
  expect(collapsed.width).toBeLessThan(expanded.width)
  expect(collapsed.items, 'collapsing must not drop destinations').toEqual(expanded.items)

  for (const view of ROUTES) {
    await showView(sharedPage, view)
    expect((await readNav(sharedPage)).width, `${view}: collapsed width`).toBe(collapsed.width)
  }

  await showView(sharedPage, 'terminal')
  await sharedPage.locator('[data-global-nav-control="toggle"]').click()
  await expect(sharedPage.locator('[data-global-nav]')).toHaveAttribute(
    'data-global-nav-collapsed',
    'false'
  )
})
