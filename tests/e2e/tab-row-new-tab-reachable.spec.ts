import type { ElectronApplication, Page } from '@stablyai/playwright-test'

import { expect, test } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { measureWorkspaceColumns } from './helpers/workspace-layout-geometry'

/**
 * The tab row's "New tab" button must be the element under its own centre.
 *
 * The row shares the top band with the application menu's overhang on the left and the terminal
 * toolbar and project-name cluster on the right; the tab strip takes what is left and clips its
 * content. At 1366 px the menu fit check ignored the columns left of the header and the terminal
 * toolbar, so the strip got 0 px (Spanish) or 22 px (English) and the "+" was clipped away.
 */

const WINDOW_HEIGHT = 768
// Spanish has the longest menu labels of the measured pair; English was clipped too (22 px strip).
const LOCALES = ['es', 'en-US']

async function setWindowWidth(electronApp: ElectronApplication, width: number): Promise<void> {
  await electronApp.evaluate(
    ({ BrowserWindow }, size) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(size.width, size.height)
    },
    { width, height: WINDOW_HEIGHT }
  )
}

type Hit = {
  rect: { x: number; width: number } | null
  hitIsButton: boolean
  hitLabel: string | null
  stripWidth: number | null
}

async function measureNewTabHit(page: Page): Promise<Hit> {
  return page.evaluate(() => {
    const button = document.querySelector<HTMLElement>('[data-testid="tab-bar-new-tab"]')
    if (!button) {
      return { rect: null, hitIsButton: false, hitLabel: null, stripWidth: null }
    }
    // The tab strip surface is the clipping box the button lives in.
    const strip = button.closest<HTMLElement>('[data-native-file-drop-target="editor"]')
    const r = button.getBoundingClientRect()
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
    return {
      rect: { x: Math.round(r.x), width: Math.round(r.width) },
      hitIsButton: Boolean(hit && button.contains(hit)),
      hitLabel: hit?.closest('[aria-label]')?.getAttribute('aria-label') ?? null,
      stripWidth: strip ? Math.round(strip.getBoundingClientRect().width) : null
    }
  })
}

for (const locale of LOCALES) {
  test.describe(`tab row "New tab" reachability (${locale})`, () => {
    test.use({ orcaAppExtraArgs: [`--lang=${locale}`] })

    for (const width of [1366, 1920]) {
      test(`"New tab" receives its own clicks at ${width}px`, async ({ orcaPage, electronApp }) => {
        await waitForSessionReady(orcaPage)
        await waitForActiveWorktree(orcaPage)
        await setWindowWidth(electronApp, width)

        // Station control: the group header is mounted, so a missing button cannot read as reachable.
        await expect(orcaPage.locator('[data-tab-group-strip-id]').first()).toBeVisible({
          timeout: 20_000
        })
        await expect(orcaPage.getByTestId('tab-bar-new-tab').first()).toBeAttached()
        // The terminal toolbar shares the row (its separator renders only for a terminal tab), so the
        // toolbar half of the fit check is exercised, not just the header's left offset.
        await expect(
          orcaPage.locator('[data-tab-row-trailing-chrome] > div[aria-hidden]').first()
        ).toBeAttached()

        // The menu strip folds on a ResizeObserver, so read geometry once it has stopped moving.
        await expect.poll(() => orcaPage.evaluate(() => window.innerWidth)).toBe(width)
        await orcaPage.waitForTimeout(2000)

        const hit = await measureNewTabHit(orcaPage)
        const columns = await measureWorkspaceColumns(orcaPage)
        console.log(
          `[tab-row-new-tab] ${JSON.stringify({ locale, width, ...hit, menuLabels: columns.menuStripLabels.length, compactMenu: columns.compactMenuButtonPresent })}`
        )
        expect(
          hit.hitIsButton,
          `centre of "New tab" (${JSON.stringify(hit.rect)}) hits "${hit.hitLabel}"; strip ${hit.stripWidth}px`
        ).toBe(true)

        // The application menu stays reachable either way; with room it keeps its labels, so the
        // fix is not simply "always fold the menu".
        expect(columns.menuStripLabels.length > 0 || columns.compactMenuButtonPresent).toBe(true)
        if (width === 1920) {
          expect(
            columns.menuStripLabels.length,
            'menu folded although the band has room'
          ).toBeGreaterThan(0)
        }

        // The button that is hit must also open its menu: a real click, no force.
        await orcaPage.getByTestId('tab-bar-new-tab').first().click()
        await expect(orcaPage.getByRole('menu')).toBeVisible({ timeout: 10_000 })
        await orcaPage.keyboard.press('Escape')
      })
    }
  })
}

test.describe('tab row tenants re-measured without a window resize', () => {
  test.use({ orcaAppExtraArgs: ['--lang=es'] })

  test('a wider trailing toolbar folds the menu with no resize', async ({
    orcaPage,
    electronApp
  }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await setWindowWidth(electronApp, 1920)
    await expect.poll(() => orcaPage.evaluate(() => window.innerWidth)).toBe(1920)
    await expect(orcaPage.locator('[data-tab-row-trailing-chrome]').first()).toBeAttached({
      timeout: 20_000
    })

    // Control: with room, the menu keeps its labels.
    await expect
      .poll(async () => (await measureWorkspaceColumns(orcaPage)).menuStripLabels.length, {
        timeout: 10_000
      })
      .toBeGreaterThan(0)

    // Widen the toolbar the way a tab switch or extra buttons do: no window resize happens.
    await orcaPage.evaluate(() => {
      const spacer = document.createElement('div')
      spacer.dataset.testWidener = ''
      spacer.style.width = '700px'
      spacer.style.flexShrink = '0'
      document.querySelector('[data-tab-row-trailing-chrome]')?.appendChild(spacer)
    })

    await expect
      .poll(async () => (await measureWorkspaceColumns(orcaPage)).compactMenuButtonPresent, {
        timeout: 10_000,
        message: 'the menu was not re-measured when the tab row toolbar grew'
      })
      .toBe(true)
  })
})
