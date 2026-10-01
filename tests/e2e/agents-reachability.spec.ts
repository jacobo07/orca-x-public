import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'

// PRODUCT REACHABILITY GATE — durable agents, reached through Workspace.
//
// Can a PERSON create an agent, and is it still there afterwards? Since 2026-09-24 the agent
// directory is the Workspace roster, reached from the rail entry directly below Explorer; the old
// opt-in Agents page is gone. This drives the real rail entry, the real New agent dialog and a real
// application restart — no store pokes beyond the settings call Settings makes, no direct
// navigation, no IPC called from the test.
//
// It restarts the APPLICATION rather than reloading the renderer: a reload keeps the same process
// and memory, so it cannot tell a durable record from a cached one.
//
// `orcaPage`, never `page` (see tests/e2e/AGENTS.md). THE LABEL IS NOT A HANDLE: this host may run
// Orca in Spanish, so every presence and absence assertion keys on `data-workspace-activity`.

const AGENT_NAME = 'Runtime Architect'
const AGENT_ROLE = 'keeps the daemon honest'

const workspaceEntry = '[data-workspace-activity="agent-workspace"]'

// Two full Electron launches plus a real durable write do not fit the default per-test budget.
test.setTimeout(300_000)

/** The rail is on screen: `workspace` (Terminals) is default-on for any profile. */
async function expectRailStation(page: Page): Promise<void> {
  await expect(page.locator('[data-workspace-activity="workspace"]').first()).toBeVisible()
}

async function openWorkspaceAgents(page: Page, app: ElectronApplication): Promise<void> {
  // Wide enough that the roster column is laid out beside the chat.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1700, 960))
  await page.locator(workspaceEntry).first().click()
  await expect(page.getByTestId('conversations-page')).toBeVisible()
  await page.getByTestId('workspace-tab-agents').click()
}

test('a person can create an agent in Workspace and find the same one after a restart', async ({
  testRepoPath
}, testInfo) => {
  const session = createRestartSession(testInfo)

  try {
    // ── First launch ────────────────────────────────────────────────────────────────────────────
    const first = await session.launch()
    await attachRepoAndOpenTerminal(first.page, testRepoPath)
    await expectRailStation(first.page)

    // Default-on: present with no setting touched, labelled in SOME language.
    await expect(first.page.locator(workspaceEntry)).toHaveCount(1)
    expect(
      (await first.page.locator(workspaceEntry).getAttribute('aria-label'))?.length ?? 0
    ).toBeGreaterThan(0)
    // The retired entries are not on screen (the station above proves the rail is).
    await expect(first.page.locator('[data-workspace-activity="agents"]')).toHaveCount(0)
    await expect(first.page.locator('[data-workspace-activity="conversations"]')).toHaveCount(0)

    await openWorkspaceAgents(first.page, first.app)

    // Nothing exists yet, and the roster says so rather than rendering an empty list silently.
    await expect(first.page.getByTestId('workspace-agents-empty')).toBeVisible()
    await expect(first.page.getByTestId('workspace-agent-row')).toHaveCount(0)

    // ── The create, through the real dialog ─────────────────────────────────────────────────────
    await first.page.getByTestId('workspace-new-agent').click()
    await expect(first.page.getByTestId('new-agent-dialog')).toBeVisible()
    await first.page.getByTestId('new-agent-name').fill(AGENT_NAME)
    await first.page.getByTestId('new-agent-role').fill(AGENT_ROLE)
    await first.page.getByTestId('new-agent-submit').click()

    // The dialog closes only on a durable success, so its disappearance is itself evidence.
    await expect(first.page.getByTestId('new-agent-dialog')).toHaveCount(0)

    const rows = first.page.getByTestId('workspace-agent-row')
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
    await openWorkspaceAgents(second.page, second.app)

    const rowsAfter = second.page.getByTestId('workspace-agent-row')
    // Exactly one: a create that ran twice, or a restart that re-seeded, both show up here.
    await expect(rowsAfter).toHaveCount(1)
    // Same agent BY IDENTITY: a freshly minted one would also be one row with the same name.
    await expect(rowsAfter.first()).toHaveAttribute('data-agent-id', agentId!)
    await expect(rowsAfter.first()).toContainText(AGENT_ROLE)
    await expect(second.page.getByTestId('workspace-agents-empty')).toHaveCount(0)

    await session.close(second.app)
  } finally {
    // dispose() waits out a transient Windows lock and reports residue softly, so it never
    // replaces a body failure and is never silently accepted.
    await session.dispose()
  }
})
