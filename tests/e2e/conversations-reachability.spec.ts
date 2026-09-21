import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'

// PRODUCT REACHABILITY GATE — W3.
//
// Everything else about conversations is proven below the UI. This is the only test that answers
// the question the whole wave exists for: can a PERSON reach one? It drives the real rail entry,
// the real New chat, the real composer, and a real reload — no store pokes, no direct navigation,
// no IPC called from the test.
//
// The e2e profile has an isolated home and no CODEX_HOME, so the provider is genuinely not signed
// in. That is not a limitation here, it is the point: the honest-failure path is a done-gate item,
// and this proves the user's message survives a turn that could not run.

// NOT `seedTestRepo: false`. That opt-out skips the fixture's full setup — the path that dismisses
// the first-run onboarding wizard and waits for the store to exist. Without it the app sits on
// onboarding forever and every locator here times out against a modal, which is what it did.

const PROMPT = 'What should we build first?'

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

/** The renderer has to be up before anything here means anything. Without this, the absence
 *  assertion below would pass against a page that had not finished booting. */
async function waitForBridge(page: Page): Promise<void> {
  await page.waitForFunction(
    () => typeof window.__store?.getState?.()?.updateSettingsOrThrow === 'function',
    undefined,
    { timeout: 60_000 }
  )
}

// NOT PASSING YET, and marked so rather than deleted or quietly skipped.
//
// The app builds and boots under this harness. `__store` IS present in the renderer bundle when
// built with `electron-vite build --mode e2e` and `VITE_EXPOSE_STORE=true` — note the
// `run-electron-vite-build.mjs` wrapper does NOT produce it, only the direct binary does. Even
// then `window.__store` never appears in the page, so the wait below times out.
//
// Also known: `npx` is broken host-wide, so global-setup's own build step fails and the build has
// to be done by hand first with SKIP_BUILD=1. A control run of the untouched
// golden-windows-fresh-startup spec renders a first-run onboarding wizard, which is how we know
// the renderer is healthy and this is harness wiring rather than the feature.
//
// Everything this spec would prove is proven below the UI, including against the real provider —
// see `src/main/conversation/conversation-reality.test.ts` (ORCA_CODEX_REALITY=1), which passes.
// What stays unproven is that a PERSON can reach it through the rail, and that claim is made
// nowhere until this is green.
test.fixme('a person can create a conversation, send, and find it again after a reload', async ({
  page
}) => {
  await waitForBridge(page)

  // ── The surface is genuinely opt-in ───────────────────────────────────────────────────────────
  // This absence is only evidence because the SAME selector finds the button a few lines later,
  // after the setting is turned on. On its own, `toHaveCount(0)` is equally satisfied by a blank
  // page and by a selector that never matches anything.
  await expect(page.getByRole('button', { name: 'Chats' })).toHaveCount(0)

  await enableConversations(page)
  await expect(page.getByRole('button', { name: 'Chats' })).toHaveCount(1)

  await openConversations(page)

  // ── New chat is a draft, and sending is what makes it real ────────────────────────────────────
  await page.getByTestId('conversations-new-chat').click()
  await expect(page.getByTestId('conversations-list-row')).toHaveCount(0)

  await page.getByTestId('conversation-composer').fill(PROMPT)
  await page.getByTestId('conversation-send').click()

  // ── The provider is not signed in here, and the product says so in its own words ──────────────
  const notice = page.getByTestId('conversation-notice')
  await expect(notice).toBeVisible({ timeout: 30_000 })
  await expect(notice).toHaveAttribute('data-notice-kind', 'auth-required')

  // The message the user typed survived a turn that could not run. This is the assertion that
  // would fail if the composer cleared optimistically and nothing was committed.
  await expect(page.getByText(PROMPT).first()).toBeVisible()

  // ── It is now a real, discoverable conversation ───────────────────────────────────────────────
  const rows = page.getByTestId('conversations-list-row')
  await expect(rows).toHaveCount(1)
  const conversationId = await rows.first().getAttribute('data-conversation-id')
  expect(conversationId).toMatch(/^conv_/)

  // ── Reload: the renderer is gone, the record is not ───────────────────────────────────────────
  await page.reload()
  await waitForBridge(page)
  await enableConversations(page)
  await openConversations(page)

  const rowsAfter = page.getByTestId('conversations-list-row')
  await expect(rowsAfter).toHaveCount(1)
  // Same conversation, by identity and not by position: a freshly minted one would also be a
  // single row, and would pass a count-only assertion.
  await expect(rowsAfter.first()).toHaveAttribute('data-conversation-id', conversationId!)

  await rowsAfter.first().click()
  // Same history, read back from disk by a renderer that never saw it written.
  await expect(page.getByText(PROMPT).first()).toBeVisible()
})
