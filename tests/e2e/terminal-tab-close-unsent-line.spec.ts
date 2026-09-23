/**
 * Product reality for closing a terminal whose shell holds an unsent line the renderer lost across
 * a reload: Cmd/Ctrl+W must raise the draft prompt, and cancelling keeps the tab and its shell.
 * The control clears the line and requires the same keystroke to close with no prompt.
 *
 * Handles are a role, data attributes and store state only; this host runs Orca in Spanish, and an
 * absence check keyed on a translated title passes whether the dialog exists or not. The keystroke
 * reaches the shared closeTerminalTab guard (the pane delegates its last-pane close to it).
 */
import { test, expect } from './helpers/orca-app'
import type { Page } from '@stablyai/playwright-test'
import {
  waitForSessionReady,
  waitForActiveWorktree,
  getActiveTabId,
  ensureTerminalVisible
} from './helpers/store'
import {
  focusActiveTerminalInput,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForPaneCount
} from './helpers/terminal'

const DRAFT_DIALOG = '[role="dialog"][data-copy-kind="unsent-input"]'
// Why data-state: a dismissed Radix dialog stays mounted at opacity 0 while its exit animation
// never ends headless, and Playwright's :visible ignores opacity.
const ANY_CLOSE_DIALOG = '[role="dialog"][data-copy-kind][data-state="open"]'

async function hostInput(page: Page, ptyId: string): Promise<unknown> {
  return (await page.evaluate((id) => window.api.pty.inspectProcess(id), ptyId)).inputSincePrompt
}

async function pressClose(page: Page): Promise<void> {
  await focusActiveTerminalInput(page)
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+w' : 'Control+w')
}

async function tabExists(page: Page, tabId: string): Promise<boolean> {
  return page.evaluate(
    (id) =>
      Object.values(window.__store!.getState().tabsByWorktree).some((tabs) =>
        tabs.some((tab) => tab.id === id)
      ),
    tabId
  )
}

test('closing a terminal whose shell holds a line the renderer lost raises the draft prompt', async ({
  orcaPage
}) => {
  test.setTimeout(180_000)
  const page = orcaPage
  await waitForSessionReady(page)
  await waitForActiveWorktree(page)
  await ensureTerminalVisible(page)
  const hasPaneManager = await waitForActiveTerminalManager(page, 30_000)
    .then(() => true)
    .catch(() => false)
  test.skip(!hasPaneManager, 'Electron automation never mounted the live TerminalPane manager.')
  await waitForPaneCount(page, 1, 30_000)
  const ptyId = await waitForActivePanePtyId(page)
  const tabId = (await getActiveTabId(page))!
  await expect
    .poll(
      async () =>
        (await page.evaluate((id) => window.api.pty.inspectProcess(id), ptyId)).promptState,
      { timeout: 30_000, message: 'the shell reached its prompt' }
    )
    .toBe('prompt')

  // Precondition: the host vouches for the line; the renderer never saw it, and then reloads.
  await page.evaluate((id) => window.api.pty.write(id, 'echo close-draft-line'), ptyId)
  await expect
    .poll(() => hostInput(page, ptyId), { timeout: 30_000, message: 'the host saw the line' })
    .toBe('typed')
  await page.reload()
  await waitForSessionReady(page)
  await ensureTerminalVisible(page)
  await waitForActiveTerminalManager(page, 30_000)
  expect(await hostInput(page, ptyId)).toBe('typed')

  await pressClose(page)
  await expect(page.locator(DRAFT_DIALOG)).toBeVisible({ timeout: 15_000 })
  await page.keyboard.press('Escape')
  await expect(page.locator(ANY_CLOSE_DIALOG)).toHaveCount(0)
  expect(await tabExists(page, tabId)).toBe(true)
  expect(
    await page.evaluate(async () => (await window.api.pty.listSessions()).map((s) => s.id))
  ).toContain(ptyId)

  // Control: with the line cleared the same keystroke closes, and no prompt ever opens.
  await page.evaluate((id) => window.api.pty.write(id, '\x03'), ptyId)
  await expect
    .poll(() => hostInput(page, ptyId), { timeout: 30_000, message: 'the line was cleared' })
    .toBe('clean')
  await pressClose(page)
  await expect
    .poll(() => tabExists(page, tabId), { timeout: 15_000, message: 'the tab closed' })
    .toBe(false)
  await expect(page.locator(ANY_CLOSE_DIALOG)).toHaveCount(0)
  console.log('[close-draft-evidence] prompted=true control-closed=true')
})
