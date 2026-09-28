/**
 * A revealed pane is checked once against main's mirror, and a divergence is recorded, content-free.
 *
 * Driven end to end through the product's own path: the renderer's visibility report
 * (`pty:setRendererPtyVisible`) schedules the probe, main reads its mirror and asks the renderer to
 * serialize its buffer, and a divergence lands in main's delivery breadcrumbs — which is where the
 * freeze report reads it. The divergence is planted in the renderer's xterm only, so the mirror
 * (fed by the PTY) never sees it: exactly the shape of output the pane shows but the model does not.
 */

import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady, waitForActiveWorktree, ensureTerminalVisible } from './helpers/store'
import { waitForActiveTerminalManager, waitForActivePanePtyId } from './helpers/terminal'

type Breadcrumb = { kind: string; detail?: Record<string, unknown> }

async function mainBreadcrumbs(page: Page): Promise<Breadcrumb[]> {
  return page.evaluate(async () => {
    const report = (await (
      window as unknown as { __orcaTerminalFreezeReport?: () => Promise<unknown> }
    ).__orcaTerminalFreezeReport?.()) as { main?: { diagnostics?: { breadcrumbs?: unknown[] } } }
    return (report?.main?.diagnostics?.breadcrumbs ?? []) as Breadcrumb[]
  })
}

async function reveal(page: Page, ptyId: string): Promise<void> {
  await page.evaluate((id) => window.api.pty.setRendererPtyVisible(id, false), ptyId)
  await page.evaluate((id) => window.api.pty.setRendererPtyVisible(id, true), ptyId)
}

const countOf = (crumbs: Breadcrumb[], kind: string): number =>
  crumbs.filter((crumb) => crumb.kind === kind).length

test('a revealed pane that diverges from the mirror is recorded once, without its content', async ({
  orcaPage
}) => {
  test.setTimeout(180_000)
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage)
  const ptyId = await waitForActivePanePtyId(orcaPage)
  await orcaPage.waitForTimeout(3_000)

  // Control: a healthy pane revealed and settled must produce no anomaly.
  await reveal(orcaPage, ptyId)
  await orcaPage.waitForTimeout(2_500)
  const afterHealthy = await mainBreadcrumbs(orcaPage)
  expect(
    countOf(afterHealthy, 'reveal-convergence-anomaly'),
    `a healthy reveal was flagged: ${JSON.stringify(afterHealthy.slice(-5))}`
  ).toBe(0)

  // Plant: a row only the renderer shows.
  const planted = await orcaPage.evaluate(() => {
    const managers = (window as unknown as { __paneManagers?: Map<string, unknown> }).__paneManagers
    for (const manager of (managers?.values() ?? []) as Iterable<{
      getActivePane?: () => { terminal?: { write: (data: string) => void } } | undefined
    }>) {
      const terminal = manager.getActivePane?.()?.terminal
      if (terminal) {
        terminal.write('\r\nGHOST-ROW-ONLY-IN-THE-RENDERER\r\n')
        return true
      }
    }
    return false
  })
  expect(planted).toBe(true)

  await reveal(orcaPage, ptyId)
  await expect
    .poll(async () => countOf(await mainBreadcrumbs(orcaPage), 'reveal-convergence-anomaly'), {
      timeout: 15_000
    })
    .toBe(1)
  const crumbs = await mainBreadcrumbs(orcaPage)
  expect(JSON.stringify(crumbs)).not.toContain('GHOST-ROW')

  // The same divergence revealed again is not reported twice.
  await reveal(orcaPage, ptyId)
  await orcaPage.waitForTimeout(2_500)
  expect(countOf(await mainBreadcrumbs(orcaPage), 'reveal-convergence-anomaly')).toBe(1)
})
