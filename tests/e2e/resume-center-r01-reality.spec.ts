import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { settlePaint } from './helpers/settled-paint'
import { ensureTerminalVisible, getActiveTabId, waitForActiveWorktree } from './helpers/store'
import { waitForActiveTerminalManager } from './helpers/terminal'

/**
 * Resume Center against its r01 reference, in a running Orca (W4).
 *
 * r01 is 1512×1042, so the page is sized to that content area and captured light and dark. What
 * only the real layout can show: every hero action stays reachable as the page narrows (a third
 * action joined the row in W3), and inline snapshots replay history only once their strip can be
 * seen — hidden below `lg` or below the fold, they must stay idle.
 */

test.setTimeout(300_000)

const TABS = 7
const HERO_ACTIONS = [
  '[data-testid="resume-center-resume-all"] button',
  '[data-testid="resume-center-restore-layout"]',
  '[data-testid="resume-center-snapshots"]',
  '[data-testid="resume-center-refresh"]'
]
const SWEEP = [1512, 1366, 1280, 1180, 1100, 1024, 960, 900, 800]

async function setContent(app: ElectronApplication, width: number, height: number): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow }, size) =>
      BrowserWindow.getAllWindows()[0]?.setContentSize(size.width, size.height),
    { width, height }
  )
}

async function waitForViewport(page: Page, width: number): Promise<void> {
  // Why ±2: the content size is set in DIPs and Windows rounds it (1366 lands at 1367).
  await expect
    .poll(async () => Math.abs((await page.evaluate(() => window.innerWidth)) - width), {
      timeout: 10_000
    })
    .toBeLessThanOrEqual(2)
  await settlePaint(page)
}

/** Why each clause: a visible box can still sit past the edge, under a sibling, or clip its label. */
async function unreachableActions(page: Page): Promise<string[]> {
  return page.evaluate((selectors) => {
    const problems: string[] = []
    for (const selector of selectors) {
      const el = document.querySelector<HTMLElement>(selector)
      if (!el) {
        problems.push(`${selector}: absent`)
        continue
      }
      const box = el.getBoundingClientRect()
      if (box.width === 0 || box.height === 0) {
        problems.push(`${selector}: zero size`)
        continue
      }
      if (box.left < 0 || box.right > window.innerWidth + 0.5) {
        problems.push(
          `${selector}: outside viewport ${Math.round(box.left)}..${Math.round(box.right)}`
        )
        continue
      }
      for (let node = el.parentElement; node; node = node.parentElement) {
        const style = getComputedStyle(node)
        if (style.overflowX === 'visible') {
          continue
        }
        const clip = node.getBoundingClientRect()
        if (box.left < clip.left - 0.5 || box.right > clip.right + 0.5) {
          problems.push(
            `${selector}: clipped by ${node.tagName}.${node.className.toString().slice(0, 40)}`
          )
        }
        break
      }
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
      if (!hit || !el.contains(hit)) {
        problems.push(`${selector}: covered by ${hit?.tagName ?? 'nothing'}`)
      }
      for (const label of el.querySelectorAll<HTMLElement>('.font-medium')) {
        if (label.scrollWidth > label.clientWidth + 1) {
          problems.push(`${selector}: label clipped "${label.textContent}"`)
        }
      }
    }
    return problems
  }, HERO_ACTIONS)
}

/** A row's pane count and status must neither wrap nor overlap: narrowed, they once printed over each other. */
async function rowFactCollisions(page: Page): Promise<string[]> {
  return page.getByTestId('resume-center-tab-row').evaluateAll((rows) =>
    rows.flatMap((row) => {
      const id = (row as HTMLElement).dataset.tabId
      const panes = row.querySelector<HTMLElement>('[data-row-fact="panes"]')
      const residency = row.querySelector<HTMLElement>('[data-row-fact="residency"]')
      if (!panes || !residency) {
        return [`${id}: facts absent`]
      }
      const problems: string[] = []
      const a = panes.getBoundingClientRect()
      const b = residency.getBoundingClientRect()
      if (
        a.right > b.left + 0.5 &&
        a.left < b.right - 0.5 &&
        a.bottom > b.top &&
        a.top < b.bottom
      ) {
        problems.push(`${id}: panes overlap residency`)
      }
      // At 800px the status once ran past the row's own border.
      if (b.right > row.getBoundingClientRect().right + 0.5) {
        problems.push(`${id}: residency past the row edge`)
      }
      for (const fact of [panes, residency]) {
        const line = parseFloat(getComputedStyle(fact).lineHeight) || 16
        if (fact.getBoundingClientRect().height > line * 1.5) {
          problems.push(`${id}: ${fact.dataset.rowFact} wrapped`)
        }
      }
      return problems
    })
  )
}

async function inlineStatuses(page: Page): Promise<string[]> {
  return page
    .locator('[data-testid="resume-center-pane-preview"][data-preview-placement="inline"]')
    .evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).dataset.previewStatus ?? ''))
}

test.describe('@resume-center', () => {
  test('r01: reachable hero actions at every width, lazy inline snapshots, light and dark', async ({
    orcaPage,
    electronApp
  }, testInfo) => {
    const worktreeId = await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    for (let i = 1; i < TABS; i++) {
      const before = await getActiveTabId(orcaPage)
      await orcaPage.evaluate((wt) => window.__store!.getState().createTab(wt), worktreeId)
      await expect.poll(() => getActiveTabId(orcaPage), { timeout: 30_000 }).not.toBe(before)
    }

    // Narrow BEFORE the page first renders: a strip that was ever seen stays loaded (sticky).
    await setContent(electronApp, 900, 1042)
    await waitForViewport(orcaPage, 900)
    await orcaPage.locator('[data-workspace-activity="agent-workspace"]').first().click()
    await orcaPage.locator('[data-workspace-nav-item="resume"]').click()
    await expect(orcaPage.getByTestId('resume-center-page')).toBeVisible({ timeout: 15_000 })
    await expect
      .poll(
        async () => {
          await orcaPage.getByTestId('resume-center-refresh').click()
          return orcaPage.getByTestId('resume-center-tab-row').count()
        },
        { timeout: 60_000, intervals: [2_000], message: 'the seeded tabs never reached the desk' }
      )
      .toBe(TABS)

    // Hidden below lg: the thumbs exist in the DOM and must never have asked for history.
    const hiddenStatuses = await (async () => {
      const seen = new Set<string>()
      for (let sample = 0; sample < 8; sample++) {
        for (const status of await inlineStatuses(orcaPage)) {
          seen.add(status)
        }
        await orcaPage.waitForTimeout(250)
      }
      return [...seen]
    })()
    expect(
      (await inlineStatuses(orcaPage)).length,
      'positive control: inline thumbs rendered'
    ).toBe(TABS)
    expect(hiddenStatuses, 'inline snapshots fetched while hidden at 900px').toEqual(['idle'])

    // Short and wide: the strips above the fold load, the last one below the fold does not.
    await setContent(electronApp, 1512, 560)
    await waitForViewport(orcaPage, 1512)
    const rows = orcaPage.getByTestId('resume-center-tab-row')
    const lastStrip = rows.last().locator('[data-preview-placement="inline"]').first()
    const firstStrip = rows.first().locator('[data-preview-placement="inline"]').first()
    await expect(firstStrip).not.toHaveAttribute('data-preview-status', 'idle', { timeout: 30_000 })
    const lastBelowFold = await lastStrip.evaluate(
      (node) => node.getBoundingClientRect().top > window.innerHeight
    )
    expect(lastBelowFold, 'precondition: the last row must start below the fold').toBe(true)
    await orcaPage.waitForTimeout(1_500)
    await expect(lastStrip).toHaveAttribute('data-preview-status', 'idle')
    await lastStrip.scrollIntoViewIfNeeded()
    await expect(lastStrip).not.toHaveAttribute('data-preview-status', 'idle', { timeout: 30_000 })
    // Identity: every inline thumb names its own row's tab.
    const mismatched = await rows.evaluateAll((items) =>
      items.flatMap((row) =>
        [...row.querySelectorAll<HTMLElement>('[data-preview-placement="inline"]')]
          .filter((thumb) => thumb.dataset.tabId !== (row as HTMLElement).dataset.tabId)
          .map((thumb) => thumb.dataset.tabId ?? '')
      )
    )
    expect(mismatched).toEqual([])

    // Reference geometry, light then dark.
    await setContent(electronApp, 1512, 1042)
    await waitForViewport(orcaPage, 1512)
    await orcaPage.getByTestId('resume-center-page').evaluate((node) => node.scrollIntoView())
    for (const theme of ['light', 'dark'] as const) {
      await orcaPage.evaluate(
        (t) => window.__store!.getState().updateSettingsOrThrow({ theme: t }),
        theme
      )
      await expect
        .poll(() => orcaPage.evaluate(() => document.documentElement.classList.contains('dark')))
        .toBe(theme === 'dark')
      await settlePaint(orcaPage)
      expect(await unreachableActions(orcaPage), `${theme} 1512×1042`).toEqual([])
      await orcaPage.screenshot({ path: testInfo.outputPath(`r01-1512x1042-${theme}.png`) })
    }
    await orcaPage.evaluate(() =>
      window.__store!.getState().updateSettingsOrThrow({ theme: 'light' })
    )

    // Width sweep: wrapping is allowed, an unreachable or clipped action is not.
    const sweep: Record<number, string[]> = {}
    for (const width of SWEEP) {
      await setContent(electronApp, width, 1042)
      await waitForViewport(orcaPage, width)
      sweep[width] = [
        ...(await unreachableActions(orcaPage)),
        ...(await rowFactCollisions(orcaPage))
      ]
      await orcaPage.screenshot({ path: testInfo.outputPath(`r01-width-${width}.png`) })
    }
    await testInfo.attach('hero-sweep.json', { body: JSON.stringify(sweep, null, 2) })
    expect(sweep).toEqual(Object.fromEntries(SWEEP.map((width) => [width, []])))
  })
})
