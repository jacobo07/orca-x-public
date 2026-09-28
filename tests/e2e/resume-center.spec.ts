import { randomUUID } from 'node:crypto'
import type { Locator, Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { ensureTerminalVisible, getActiveTabId, waitForActiveWorktree } from './helpers/store'
import {
  execInTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
} from './helpers/terminal'

/**
 * The Resume Center, in a running Orca.
 *
 * Unit tests proved the projection and the preview renderer from fixtures. What only a real app can
 * show: that main's saved desk and the host's live list reach the page, and that expanding a tab
 * draws THAT tab's recorded screen from daemon history. Two tabs with different output make the
 * subject discriminating — a preview of the wrong pane, or of whichever terminal is active, fails.
 *
 * Markers are printed by node as a concatenation, so the joined string exists only in the output:
 * a preview that recorded just the typed command line cannot satisfy the assertion. Handles are
 * test ids and data attributes only; hosts run Orca in other languages.
 */

test.setTimeout(240_000)

type SeededTab = { tabId: string; marker: string }

function markerCommand(prefix: string, id: string): string {
  return `node -e "console.log('${prefix}'+'-${id}')"`
}

async function seedTab(page: Page, prefix: string): Promise<SeededTab> {
  const tabId = await getActiveTabId(page)
  expect(tabId, 'no active tab to seed').toBeTruthy()
  const ptyId = await waitForActivePanePtyId(page)
  const id = randomUUID().slice(0, 8)
  const marker = `${prefix}-${id}`
  await execInTerminal(page, ptyId, markerCommand(prefix, id))
  // Precondition: the terminal itself produced the marker, so a missing preview is the page's fault.
  await expect
    .poll(
      async () =>
        page.evaluate(
          async (pty) =>
            (await window.api?.pty?.getMainBufferSnapshot?.(pty, { scrollbackRows: 0 }))?.data ??
            '',
          ptyId
        ),
      { timeout: 30_000, message: `the ${prefix} terminal never printed its marker` }
    )
    .toContain(marker)
  return { tabId: tabId as string, marker }
}

function tabRow(page: Page, tabId: string): Locator {
  return page.locator(`[data-testid="resume-center-tab-row"][data-tab-id="${tabId}"]`)
}

async function refreshDesk(page: Page): Promise<void> {
  await page.getByTestId('resume-center-refresh').click()
}

/** Expand the row (a refresh remounts it collapsed) and return its preview's status and text. */
async function readRowPreview(
  page: Page,
  tabId: string
): Promise<{ status: string | null; text: string }> {
  const row = tabRow(page, tabId)
  if ((await row.count()) === 0) {
    return { status: 'row-absent', text: '' }
  }
  const toggle = row.locator('button[aria-expanded]').first()
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') {
    await toggle.click()
  }
  const preview = row.getByTestId('resume-center-pane-preview').first()
  return {
    status: await preview.getAttribute('data-preview-status'),
    text: (await preview.textContent()) ?? ''
  }
}

test.describe('@resume-center', () => {
  test('the Resume Center lists the desk and shows each tab its own recorded screen', async ({
    orcaPage
  }) => {
    const worktreeId = await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)

    const first = await seedTab(orcaPage, 'RCA')
    await orcaPage.evaluate((wt) => window.__store!.getState().createTab(wt), worktreeId)
    await expect
      .poll(async () => getActiveTabId(orcaPage), {
        timeout: 30_000,
        message: 'the second tab never became active'
      })
      .not.toBe(first.tabId)
    const second = await seedTab(orcaPage, 'RCB')

    await orcaPage.locator('[data-workspace-activity="agent-workspace"]').first().click()
    await orcaPage.getByTestId('workspace-open-resume-center').click()
    await expect(orcaPage.getByTestId('resume-center-page')).toBeVisible({ timeout: 15_000 })

    // Both tabs reach the desk, and both read as running because the host lists their sessions.
    await expect
      .poll(
        async () => {
          await refreshDesk(orcaPage)
          return Promise.all(
            [first, second].map(async (tab) =>
              (await tabRow(orcaPage, tab.tabId).count()) === 0
                ? 'absent'
                : tabRow(orcaPage, tab.tabId).getAttribute('data-residency')
            )
          )
        },
        { timeout: 60_000, intervals: [2_000], message: 'the seeded tabs never reached the desk' }
      )
      .toEqual(['warm', 'warm'])

    // Each row's snapshot carries its own marker and never its sibling's. History is checkpointed
    // every few seconds while a session runs, so poll through Refresh rather than read once.
    for (const [subject, sibling] of [
      [first, second],
      [second, first]
    ] as const) {
      await expect
        .poll(
          async () => {
            await refreshDesk(orcaPage)
            const preview = await readRowPreview(orcaPage, subject.tabId)
            return preview.status === 'rendered' && preview.text.includes(subject.marker)
              ? 'own-screen'
              : `${preview.status}`
          },
          {
            timeout: 90_000,
            intervals: [3_000],
            message: `the ${subject.marker} row never showed its own recorded screen`
          }
        )
        .toBe('own-screen')
      const preview = await readRowPreview(orcaPage, subject.tabId)
      expect(preview.text, `the ${subject.marker} row showed its sibling's screen`).not.toContain(
        sibling.marker
      )
    }

    await orcaPage.screenshot({ path: 'pr-evidence/resume-center.png' })
  })
})
