import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { pickNewAgentProject } from './helpers/new-agent-project-picker'
import { expect, test } from './helpers/orca-app'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'

// PRODUCT REACHABILITY GATE — W-C5, an agent's turn is located by its project.
//
// Below the UI it is proven that the agent's project decides the working directory and that an
// unreachable project refuses. This asks the question only a person can, and it does it WITHOUT a
// provider credential, because of where the refusal sits in the turn:
//
//   agent binding -> PROJECT LOCATION -> admission -> durable user message -> auth -> provider
//
// So reaching `auth-required` is positive evidence that the project RESOLVED: a turn whose project
// could not be located never gets that far. And the control is the same person doing the same
// thing after the project is gone, which must refuse with its own words and commit nothing.
//
// Both halves matter. Without the refusal, "it resolved" is satisfied by a build that never checks;
// without the success, a build that refuses everything passes the refusal half and looks correct.
//
// Same instruments as agent-chat-reachability.spec.ts: `orcaPage` via the helpers (never `page`),
// locale-free handles (this host runs Orca in Spanish), and cleanup that cannot replace the verdict.

const AGENT_NAME = 'Ledger Reviewer'
const AGENT_ROLE = 'knows this project'
const PROMPT = 'What is in this repository?'

// Since 2026-09-24 the agent directory is the Workspace roster, reached from the rail entry
// directly below Explorer.
const workspaceEntry = '[data-workspace-activity="agent-workspace"]'

test.setTimeout(300_000)

async function openWorkspaceAgents(page: Page, app: ElectronApplication): Promise<void> {
  // Wide enough that the roster column is laid out beside the chat.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1700, 960))
  await page.locator(workspaceEntry).first().click()
  await expect(page.getByTestId('conversations-page')).toBeVisible()
  await page.getByTestId('workspace-tab-agents').click()
}

function agentRow(page: Page, agentId: string) {
  return page.locator(`[data-testid="workspace-agent-row"][data-agent-id="${agentId}"]`)
}

/** The repos the product currently knows about, read through its own API. */
async function readRepos(page: Page): Promise<{ id: string; path: string }[]> {
  return page.evaluate(async () => {
    const repos = await window.api.repos.list()
    return repos.map((repo) => ({ id: repo.id, path: repo.path }))
  })
}

async function sendPrompt(page: Page, text: string): Promise<string> {
  await page.getByTestId('conversation-composer').fill(text)
  await page.getByTestId('conversation-send').click()
  const notice = page.getByTestId('conversation-notice')
  await expect(notice).toBeVisible({ timeout: 30_000 })
  return (await notice.getAttribute('data-notice-kind')) ?? ''
}

test('an agent bound to a project reaches the provider, and refuses once that project is gone', async ({
  testRepoPath
}, testInfo) => {
  const session = createRestartSession(testInfo)

  try {
    const first = await session.launch()
    await attachRepoAndOpenTerminal(first.page, testRepoPath)
    await expect(first.page.locator('[data-workspace-activity="workspace"]')).toBeVisible()

    // Precondition, asserted rather than assumed: the attached repo is a project the product can
    // locate. Without this the refusal half below would pass for the wrong reason.
    const repos = await readRepos(first.page)
    expect(repos.length).toBeGreaterThan(0)

    await openWorkspaceAgents(first.page, first.app)
    await first.page.getByTestId('workspace-new-agent').click()
    await first.page.getByTestId('new-agent-name').fill(AGENT_NAME)
    await first.page.getByTestId('new-agent-role').fill(AGENT_ROLE)

    // Bind the agent to a real project — the choice a person makes in this dialog. The helper
    // asserts a real one was bound: "no project" by accident would make the success half pass for
    // the wrong reason and the refusal half impossible.
    await pickNewAgentProject(first.page, 'first')

    await first.page.getByTestId('new-agent-submit').click()
    await expect(first.page.getByTestId('new-agent-dialog')).toHaveCount(0)

    const row = first.page.getByTestId('workspace-agent-row')
    await expect(row).toHaveCount(1)
    const agentId = await row.first().getAttribute('data-agent-id')
    expect(agentId).toMatch(/^agent_/)

    // ── The success half: the project resolves, so the turn reaches the provider check ──────────
    await agentRow(first.page, agentId!).click()
    await expect(first.page.getByTestId('conversations-page')).toHaveAttribute(
      'data-conversation-scope',
      'agent'
    )

    const located = await sendPrompt(first.page, PROMPT)
    // auth-required, NOT any project refusal: the location gate sits BEFORE the auth gate, so
    // getting here is evidence the agent's project was resolved to a directory on this computer.
    expect(located).toBe('auth-required')
    // And the user's message survived, because the turn got past admission.
    await expect(first.page.getByText(PROMPT).first()).toBeVisible()

    // ── The control: the same agent, after its project is gone ──────────────────────────────────
    // Removed through the product's own API, which is how a person forgets a project.
    await first.page.evaluate(async (repoId) => {
      await window.api.repos.remove({ repoId })
    }, repos[0].id)

    await openWorkspaceAgents(first.page, first.app)
    await agentRow(first.page, agentId!).click()

    const refused = await sendPrompt(first.page, 'And now?')
    // Its own words, not a generic fault: this one sends a person to set the project up here.
    expect(refused).toBe('project-not-set-up')
    // Nothing was committed — the second prompt is not in the conversation.
    await expect(first.page.getByText('And now?')).toHaveCount(0)

    await session.close(first.app)
  } finally {
    // Cleanup must not decide the verdict: a Windows EPERM on the temp profile would otherwise
    // replace a real assertion failure (see agents-reachability.spec.ts).
    await session.dispose().catch((error: unknown) => {
      console.error(
        `[agent-project-location-e2e] cleanup failed (not a test result): ${String(error)}`
      )
    })
  }
})
