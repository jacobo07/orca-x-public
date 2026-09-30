import { expect, test } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

// PHASE TRACER — a person opens Backlog from the rail, captures one Unassigned item through the
// dialog, and sees it listed from a ledger-confirmed write. 02-06 extends this to the restart proof.
//
// `orcaPage`, never `page`: Playwright's `page` is a blank Chromium tab with no Orca in it, where
// every absence assertion passes. Every locator is a data-* handle; the E2E host may render Spanish.

test.setTimeout(300_000)

type LedgerItem = { id: string; originalText: string; projectRefs: unknown[] }

test('a person captures an Unassigned item and sees the ledger-confirmed row', async ({
  orcaPage
}) => {
  await waitForSessionReady(orcaPage)
  // Station control: the rail is on screen before anything inside it is reasoned about.
  await expect(orcaPage.locator('[data-workspace-activity="workspace"]')).toBeVisible()

  await orcaPage.locator('[data-workspace-activity="backlog"]').first().click()
  const backlogPage = orcaPage.locator('[data-backlog-page]')
  await expect(backlogPage).toBeVisible()
  await expect(backlogPage).toHaveAttribute('data-backlog-status', /^(ready|empty|filter-empty)$/, {
    timeout: 30_000
  })

  const token = `backlog tracer ${Date.now()}`
  await orcaPage.locator('[data-backlog-action="capture"]').click()
  const dialog = orcaPage.locator('[data-backlog-capture-dialog]')
  await expect(dialog).toBeVisible()
  await dialog.locator('[data-backlog-capture-field="text"]').fill(token)
  await dialog.locator('[data-backlog-capture-submit]').click()
  await expect(dialog).toHaveAttribute('data-backlog-capture-status', 'confirmed', {
    timeout: 30_000
  })

  // Ledger oracle over the real runtime RPC, not the store and not the DOM under test.
  const matches = await orcaPage.evaluate(async (text) => {
    const response = await window.api.runtime.call({
      method: 'backlog.list',
      params: { unassigned: true, limit: 500 }
    })
    if (!response.ok) {
      throw new Error(`backlog.list failed: ${response.error.code}`)
    }
    const result = response.result as { outcome: string; items?: LedgerItem[] }
    return (result.items ?? [])
      .filter((item) => item.originalText === text)
      .map((item) => ({ id: item.id, projectRefs: item.projectRefs }))
  }, token)
  expect(matches).toHaveLength(1)
  expect(matches[0].projectRefs).toEqual([])
  const itemId = matches[0].id

  await dialog.locator('[data-backlog-capture-close]').click()
  await expect(dialog).toHaveCount(0)
  await expect(orcaPage.locator('[data-backlog-page][data-backlog-status="ready"]')).toBeVisible()
  const row = orcaPage.locator(
    `[data-backlog-group="unassigned"] [data-backlog-item-id="${itemId}"]`
  )
  await expect(row).toBeVisible()
  await expect(row).toHaveAttribute('data-backlog-state', 'needs-triage')
})
