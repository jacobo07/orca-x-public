import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'

// PRODUCT REACHABILITY GATE — W3.
//
// Everything else about conversations is proven below the UI. This is the only test that answers
// the question the whole wave exists for: can a PERSON reach one? It drives the real rail entry,
// the real New chat, the real composer, and a real application restart — no store pokes beyond the
// settings call the Settings UI itself makes, no direct navigation, no IPC called from the test.
//
// The e2e profile has an isolated home and no CODEX_HOME, so the provider is genuinely not signed
// in. That is not a limitation here, it is the point: the honest-failure path is a done-gate item,
// and this proves the user's message survives a turn that could not run.
//
// `orcaPage`, never `page`. This spec spent a session bound to `page` — a fixture `orca-app.ts`
// does not define, so Playwright handed it a stock blank Chromium tab with no Orca in it. Every
// symptom followed from that: `window.__store` looked missing because the page was not the
// renderer, and the opt-in absence assertion passed against `about:blank`. The build was never at
// fault; the shipped bundle bakes the exposure gate to `String("true") === "true"`.
//
// It restarts the application rather than reloading the renderer. A reload leaves the same process
// holding the same memory, so it cannot distinguish a durable record from a cached one — and this
// spec's own reload version could not click anything afterwards: every post-reload element stayed
// visible and enabled but never became stable, while every pre-reload click worked. That is
// recorded as an open observation about `page.reload()` under headless Electron; it is not what
// this gate is for, and a restart is the stronger evidence regardless.

const PROMPT = 'What should we build first?'

// Two full Electron launches plus a real turn attempt do not fit the default per-test budget.
test.setTimeout(300_000)

/** Turns the surface on through the REAL settings API, the same call the Settings UI makes. The
 *  rail entry is opt-in, so a profile that never asked for it must not show it. */
async function enableConversations(page: Page): Promise<void> {
  await page.evaluate(async () => {
    // The action the Settings UI itself calls, so this is the production path and not a test hook.
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }
    await store.getState().updateSettingsOrThrow({ showConversationsButton: true })
  })
}

async function openConversations(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Chats' }).first().click()
  await expect(page.getByTestId('conversations-page')).toBeVisible()
}

/**
 * The rail must be on screen before anything inside it can be reasoned about. Without this, a page
 * that failed to mount satisfies the absence assertion below just as well as a working opt-in does
 * — which is exactly what happened while this spec was bound to the wrong fixture.
 *
 * `workspace` is default-on, so it is present for any profile, and the data attribute is the
 * product's own handle. The visible labels are translated and the E2E host here runs the app in
 * Spanish; `Chats` survives only because that key is absent from every non-English catalogue.
 */
async function expectRailStation(page: Page): Promise<void> {
  await expect(page.locator('[data-workspace-activity="workspace"]')).toBeVisible()
}

test('a person can create a conversation, send, and find it again after a restart', async ({
  testRepoPath
}, testInfo) => {
  const session = createRestartSession(testInfo)

  try {
    // ── First launch: create the conversation a person would create ─────────────────────────────
    const first = await session.launch()
    await attachRepoAndOpenTerminal(first.page, testRepoPath)
    await expectRailStation(first.page)

    // The surface is genuinely opt-in. Absence is only evidence because the SAME selectors find
    // the entry a few lines later, after the setting is turned on. Two of them: the accessible
    // name a person reads, and the locale-free attribute — so a translation change cannot turn
    // this into a silent pass.
    await expect(first.page.getByRole('button', { name: 'Chats' })).toHaveCount(0)
    await expect(first.page.locator('[data-workspace-activity="conversations"]')).toHaveCount(0)

    await enableConversations(first.page)
    await expect(first.page.getByRole('button', { name: 'Chats' })).toHaveCount(1)
    await expect(first.page.locator('[data-workspace-activity="conversations"]')).toHaveCount(1)

    await openConversations(first.page)

    // New chat is a draft; sending is what makes it real.
    await first.page.getByTestId('conversations-new-chat').click()
    await expect(first.page.getByTestId('conversations-list-row')).toHaveCount(0)

    await first.page.getByTestId('conversation-composer').fill(PROMPT)
    await first.page.getByTestId('conversation-send').click()

    // The provider is not signed in here, and the product says so in its own words rather than
    // rendering an ordinary success.
    const notice = first.page.getByTestId('conversation-notice')
    await expect(notice).toBeVisible({ timeout: 30_000 })
    await expect(notice).toHaveAttribute('data-notice-kind', 'auth-required')

    // The message the user typed survived a turn that could not run. This is what fails if the
    // composer cleared optimistically and nothing was committed.
    await expect(first.page.getByText(PROMPT).first()).toBeVisible()

    const rows = first.page.getByTestId('conversations-list-row')
    await expect(rows).toHaveCount(1)
    const conversationId = await rows.first().getAttribute('data-conversation-id')
    expect(conversationId).toMatch(/^conv_/)

    // ── Restart: a new process, the same profile on disk ────────────────────────────────────────
    await session.close(first.app)
    const second = await session.launch()
    await attachRepoAndOpenTerminal(second.page, testRepoPath)
    await expectRailStation(second.page)

    // The setting is durable, so the entry comes back on its own. Re-enabling it here — which this
    // spec used to do — would turn a setting that failed to persist into a silent pass.
    await expect(second.page.getByRole('button', { name: 'Chats' })).toHaveCount(1)
    await openConversations(second.page)

    const rowsAfter = second.page.getByTestId('conversations-list-row')
    await expect(rowsAfter).toHaveCount(1)
    // Same conversation, by identity and not by position: a freshly minted one would also be a
    // single row and would pass a count-only assertion.
    await expect(rowsAfter.first()).toHaveAttribute('data-conversation-id', conversationId!)

    await rowsAfter.first().click()
    // Same history, read from disk by a renderer in a process that never saw it written.
    await expect(second.page.getByText(PROMPT).first()).toBeVisible()

    await session.close(second.app)
  } finally {
    await session.dispose()
  }
})
