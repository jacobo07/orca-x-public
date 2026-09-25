import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'

// PRODUCT REACHABILITY GATE — W-C4, Direct Agent Chat, reached through Workspace.
//
// Below the UI it is proven that an agent-bound conversation has one producer, holds no project of
// its own, and that the agent's role reaches the provider envelope. This asks the question only a
// person can: from Workspace, can they open THIS agent, talk to it, restart Orca, and find the same
// conversation with the same agent? (Since 2026-09-24 the agent directory is the Workspace roster;
// the separate Agents page and the Chats entry are gone.)
//
// The e2e profile has no CODEX_HOME, so the provider is honestly not signed in. The turn ends
// auth-required, and that is enough for the claim here: the conversation, its agent binding and the
// user's message are all made durable BEFORE the provider is asked anything.
//
// `orcaPage` via the helpers (never `page`), locale-free handles (this host runs Orca in Spanish),
// a real restart rather than a reload, and cleanup that cannot replace the verdict.

const AGENT_NAME = 'Migration Reviewer'
const AGENT_ROLE = 'reads every migration for data loss'
const PROMPT = 'Which migration worries you most?'

const workspaceEntry = '[data-workspace-activity="agent-workspace"]'

test.setTimeout(300_000)

async function openWorkspaceAgents(page: Page, app: ElectronApplication): Promise<void> {
  // Wide enough that the roster column is laid out beside the chat.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1700, 960))
  await page.locator(workspaceEntry).first().click()
  await expect(page.getByTestId('conversations-page')).toBeVisible()
  await page.getByTestId('workspace-tab-agents').click()
}

async function openAgentChat(page: Page, agentId: string): Promise<void> {
  await page.locator(`[data-testid="workspace-agent-row"][data-agent-id="${agentId}"]`).click()
  // Station control: the chat is the scoped conversations surface, about THIS agent — not
  // Brainstorming, not a blank page, not the runtime Activity feed.
  const surface = page.getByTestId('conversations-page')
  await expect(surface).toBeVisible()
  await expect(surface).toHaveAttribute('data-conversation-scope', 'agent')
  const header = page.getByTestId('agent-chat-header')
  await expect(header).toHaveAttribute('data-lookup-status', 'found')
  await expect(header).toHaveAttribute('data-agent-id', agentId)
  await expect(page.getByTestId('agent-chat-name')).toHaveText(AGENT_NAME)
}

/** Reads the record through the product's own read API — observation, not a write path. */
async function readRecord(
  page: Page,
  id: string
): Promise<{ agentId: unknown; projectId: unknown; userTexts: string[] }> {
  return page.evaluate(async (conversationId) => {
    const result = await window.api.conversations.read({ id: conversationId })
    if (result.outcome !== 'loaded') {
      throw new Error(`conversation not loaded: ${result.outcome}`)
    }
    return {
      agentId: result.record.agentId,
      projectId: result.record.projectId,
      userTexts: result.record.messages
        .filter((message) => message.role === 'user')
        .flatMap((message) =>
          message.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : []))
        )
    }
  }, id)
}

test('a person can talk to an agent and find the same conversation after a restart', async ({
  testRepoPath
}, testInfo) => {
  const session = createRestartSession(testInfo)

  try {
    // ── First launch ────────────────────────────────────────────────────────────────────────────
    const first = await session.launch()
    await attachRepoAndOpenTerminal(first.page, testRepoPath)
    await expect(first.page.locator('[data-workspace-activity="workspace"]').first()).toBeVisible()
    await openWorkspaceAgents(first.page, first.app)

    await first.page.getByTestId('workspace-new-agent').click()
    await first.page.getByTestId('new-agent-name').fill(AGENT_NAME)
    await first.page.getByTestId('new-agent-role').fill(AGENT_ROLE)
    await first.page.getByTestId('new-agent-submit').click()
    await expect(first.page.getByTestId('new-agent-dialog')).toHaveCount(0)

    const row = first.page.getByTestId('workspace-agent-row')
    await expect(row).toHaveCount(1)
    const agentId = await row.first().getAttribute('data-agent-id')
    expect(agentId).toMatch(/^agent_/)

    // ── Stage 1: the row is a real destination ──────────────────────────────────────────────────
    await openAgentChat(first.page, agentId!)
    await expect(first.page.getByText(AGENT_ROLE).first()).toBeVisible()

    // Browsing an agent mints nothing: no conversation exists until the first send.
    const agentRows = first.page.getByTestId('conversations-list-row')
    await expect(agentRows).toHaveCount(0)

    // ── Stage 2: the first message makes an agent-bound conversation durable ───────────────────
    await first.page.getByTestId('conversation-composer').fill(PROMPT)
    await first.page.getByTestId('conversation-send').click()

    const notice = first.page.getByTestId('conversation-notice')
    await expect(notice).toBeVisible({ timeout: 30_000 })
    // Auth-required, NOT agent-missing/agent-unverifiable: the agent was resolved in main, and the
    // turn got as far as the provider check.
    await expect(notice).toHaveAttribute('data-notice-kind', 'auth-required')
    await expect(first.page.getByText(PROMPT).first()).toBeVisible()

    await expect(agentRows).toHaveCount(1)
    const conversationId = await agentRows.first().getAttribute('data-conversation-id')
    expect(conversationId).toMatch(/^conv_/)

    const stored = await readRecord(first.page, conversationId!)
    expect(stored.agentId).toBe(agentId)
    // The agent owns the project; the conversation holds no second value to disagree with it.
    expect(stored.projectId).toBeNull()
    expect(stored.userTexts).toEqual([PROMPT])

    // ── Back returns to the directory the agent came from: the roster's Agents list ─────────────
    await first.page.getByTestId('agent-chat-back').click()
    const brainstorm = first.page.getByTestId('conversations-page')
    await expect(brainstorm).toHaveAttribute('data-conversation-scope', 'brainstorming')
    await expect(first.page.getByTestId('workspace-tab-agents')).toHaveAttribute(
      'aria-selected',
      'true'
    )
    await expect(first.page.getByTestId('workspace-agent-row')).toHaveAttribute(
      'data-agent-id',
      agentId!
    )

    // ── Stage 7: Brainstorming stays agent-less, and does not list the agent's chat ─────────────
    // Re-entered through the rail entry itself, not only through Back.
    await first.page.locator(workspaceEntry).first().click()
    await expect(brainstorm).toHaveAttribute('data-conversation-scope', 'brainstorming')
    await expect(first.page.getByTestId('agent-chat-header')).toHaveCount(0)
    // The same selector found the row a moment ago, in the agent's scope.
    await expect(
      first.page.locator(
        `[data-testid="conversations-list-row"][data-conversation-id="${conversationId}"]`
      )
    ).toHaveCount(0)

    // ── Stage 6: restart — a new process, the same profile on disk ─────────────────────────────
    await session.close(first.app)
    const second = await session.launch()
    await attachRepoAndOpenTerminal(second.page, testRepoPath)
    await expect(second.page.locator('[data-workspace-activity="workspace"]').first()).toBeVisible()
    await openWorkspaceAgents(second.page, second.app)

    await expect(second.page.getByTestId('workspace-agent-row')).toHaveCount(1)
    await openAgentChat(second.page, agentId!)

    // The agent's latest conversation opens by itself, by identity — and there is still one.
    const rowsAfter = second.page.getByTestId('conversations-list-row')
    await expect(rowsAfter).toHaveCount(1)
    await expect(rowsAfter.first()).toHaveAttribute('data-conversation-id', conversationId!)
    await expect(second.page.getByText(PROMPT).first()).toBeVisible()

    const reread = await readRecord(second.page, conversationId!)
    expect(reread.agentId).toBe(agentId)
    expect(reread.userTexts).toEqual([PROMPT])

    await session.close(second.app)
  } finally {
    // Cleanup must not decide the verdict: a Windows EPERM on the temp profile would otherwise
    // replace a real assertion failure (see agents-reachability.spec.ts).
    await session.dispose().catch((error: unknown) => {
      console.error(`[agent-chat-e2e] cleanup failed (not a test result): ${String(error)}`)
    })
  }
})
