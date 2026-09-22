import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'

// PRODUCT REACHABILITY GATE — W-C3.
//
// Everything else about the durable agent roster is proven below the UI. This is the only test that
// answers the question the wave exists for: can a PERSON create one, and is it still there
// afterwards? It drives the real rail entry, the real New agent dialog and a real application
// restart — no store pokes beyond the settings call the Settings UI itself makes, no direct
// navigation, no IPC called from the test.
//
// It restarts the APPLICATION rather than reloading the renderer. A reload leaves the same process
// holding the same memory, so it cannot distinguish a durable record from a cached one — and the
// whole claim here is that `agents:create` resolved only once the roster was on disk.
//
// `orcaPage`, never `page`: `page` is a fixture orca-app.ts does not define, and Playwright hands a
// spec bound to it a stock blank Chromium tab in which every absence assertion passes vacuously.
//
// THE LABEL IS NOT A HANDLE HERE. The Agents entry reuses translate key
// `auto.components.sidebar.SidebarNav.9c95e1ce91`, which IS present in every catalogue — "Agentes",
// "에이전트", "智能体" — and this E2E host runs Orca in Spanish. So `getByRole('button', { name:
// 'Agents' })` would find nothing and an absence assertion written that way would be a permanent
// silent pass. The locale-free `data-workspace-activity` attribute is the product's own handle and
// is what every presence AND absence assertion below keys on. The accessible name is still checked,
// but only for being non-empty — that the entry is labelled at all, in whatever language.

const AGENT_NAME = 'Runtime Architect'
const AGENT_ROLE = 'keeps the daemon honest'

const railEntry = '[data-workspace-activity="agents"]'

// Two full Electron launches plus a real durable write do not fit the default per-test budget.
test.setTimeout(300_000)

/** Turns the surface on through the REAL settings API, the same call the Settings UI makes. */
async function enableAgents(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }
    await store.getState().updateSettingsOrThrow({ showAgentsButton: true })
  })
}

async function openAgents(page: Page): Promise<void> {
  await page.locator(railEntry).first().click()
  await expect(page.getByTestId('agents-page')).toBeVisible()
}

/**
 * The rail must be on screen before anything inside it can be reasoned about. Without this, a shell
 * that failed to mount satisfies the absence assertion below just as well as a working opt-in does.
 * `workspace` is default-on, so it is present for any profile.
 */
async function expectRailStation(page: Page): Promise<void> {
  await expect(page.locator('[data-workspace-activity="workspace"]')).toBeVisible()
}

test('a person can create an agent and find the same one after a restart', async ({
  testRepoPath
}, testInfo) => {
  const session = createRestartSession(testInfo)

  try {
    // ── First launch: create the agent a person would create ────────────────────────────────────
    const first = await session.launch()
    await attachRepoAndOpenTerminal(first.page, testRepoPath)
    await expectRailStation(first.page)

    // The surface is genuinely opt-in. Absence is only evidence because the SAME selector finds the
    // entry a few lines later, once the setting is on.
    await expect(first.page.locator(railEntry)).toHaveCount(0)
    await expect(first.page.getByTestId('agents-page')).toHaveCount(0)

    await enableAgents(first.page)
    await expect(first.page.locator(railEntry)).toHaveCount(1)
    // Labelled in SOME language. Asserting the English string here would fail on this Spanish host.
    expect((await first.page.locator(railEntry).getAttribute('aria-label'))?.length ?? 0).toBeGreaterThan(0)

    await openAgents(first.page)

    // Nothing exists yet, and the page says so rather than rendering an empty list silently.
    await expect(first.page.getByTestId('agents-empty')).toBeVisible()
    await expect(first.page.getByTestId('agents-list-row')).toHaveCount(0)

    // ── The create, through the real dialog ─────────────────────────────────────────────────────
    await first.page.getByTestId('agents-new').click()
    await expect(first.page.getByTestId('new-agent-dialog')).toBeVisible()
    await first.page.getByTestId('new-agent-name').fill(AGENT_NAME)
    await first.page.getByTestId('new-agent-role').fill(AGENT_ROLE)
    await first.page.getByTestId('new-agent-submit').click()

    // The dialog closes only on a durable success, so its disappearance is itself evidence.
    await expect(first.page.getByTestId('new-agent-dialog')).toHaveCount(0)

    const rows = first.page.getByTestId('agents-list-row')
    await expect(rows).toHaveCount(1)
    await expect(rows.first()).toContainText(AGENT_NAME)
    const agentId = await rows.first().getAttribute('data-agent-id')
    // Minted by main through mintAgentId, not assembled anywhere else.
    expect(agentId).toMatch(/^agent_/)

    // ── Restart: a new process, the same profile on disk ────────────────────────────────────────
    await session.close(first.app)
    const second = await session.launch()
    await attachRepoAndOpenTerminal(second.page, testRepoPath)
    await expectRailStation(second.page)

    // The setting is durable, so the entry comes back on its own. Re-enabling it here would turn a
    // setting that failed to persist into a silent pass.
    await expect(second.page.locator(railEntry)).toHaveCount(1)
    await openAgents(second.page)

    const rowsAfter = second.page.getByTestId('agents-list-row')
    // Exactly one: a create that ran twice, or a restart that re-seeded, both show up here.
    await expect(rowsAfter).toHaveCount(1)
    // Same agent, BY IDENTITY and not by position — a freshly minted one would also be a single
    // row with the same name and would pass a count-only or text-only assertion.
    await expect(rowsAfter.first()).toHaveAttribute('data-agent-id', agentId!)
    await expect(rowsAfter.first()).toContainText(AGENT_ROLE)
    // The empty state is gone, which is the read having actually returned the row rather than the
    // page rendering both states.
    await expect(second.page.getByTestId('agents-empty')).toHaveCount(0)

    await session.close(second.app)
  } finally {
    // Cleanup must not decide the verdict.
    //
    // `dispose()` removes a temp userDataDir, and on Windows that intermittently throws EPERM while
    // a just-closed Electron still holds a handle. In a bare `finally { await dispose() }` — which
    // is how this spec was first written, copying the conversations gate next door — that rejection
    // REPLACES whatever the try block threw, so a real assertion failure is reported as a file
    // permission error and the actual finding is lost.
    //
    // Measured: a mutation drill that removed `registerAgentHandlers` twice produced a run whose
    // only recorded error was this EPERM, leaving it impossible to say whether the product broke or
    // the temp directory was locked. Swallowing the cleanup error is what makes the drill able to
    // answer.
    await session.dispose().catch((error: unknown) => {
      console.error(`[agents-e2e] cleanup failed (not a test result): ${String(error)}`)
    })
  }
})
