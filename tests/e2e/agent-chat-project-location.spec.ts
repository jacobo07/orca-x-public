import type { Page } from '@stablyai/playwright-test'
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

const agentsEntry = '[data-workspace-activity="agents"]'

test.setTimeout(300_000)

async function enableSurfaces(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }
    await store
      .getState()
      .updateSettingsOrThrow({ showAgentsButton: true, showConversationsButton: true })
  })
}

async function openAgents(page: Page): Promise<void> {
  await page.locator(agentsEntry).first().click()
  await expect(page.getByTestId('agents-page')).toBeVisible()
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
    await enableSurfaces(first.page)

    // Precondition, asserted rather than assumed: the attached repo is a project the product can
    // locate. Without this the refusal half below would pass for the wrong reason.
    const repos = await readRepos(first.page)
    expect(repos.length).toBeGreaterThan(0)

    await openAgents(first.page)
    await first.page.getByTestId('agents-new').click()
    await first.page.getByTestId('new-agent-name').fill(AGENT_NAME)
    await first.page.getByTestId('new-agent-role').fill(AGENT_ROLE)

    // Bind the agent to a real project — the choice a person makes in this dialog. Projects come
    // first in the select and "No project" is last, so index 0 is a real one. Asserted, not
    // assumed: binding to "no project" by accident would make the success half pass for the wrong
    // reason and the refusal half impossible.
    const projectSelect = first.page.getByTestId('new-agent-project')
    await projectSelect.selectOption({ index: 0 })
    const boundProjectId = await projectSelect.inputValue()
    expect(boundProjectId).not.toBe('__none__')
    expect(boundProjectId).not.toBe('')

    await first.page.getByTestId('new-agent-submit').click()
    await expect(first.page.getByTestId('new-agent-dialog')).toHaveCount(0)

    const row = first.page.getByTestId('agents-list-row')
    await expect(row).toHaveCount(1)
    const agentId = await row.first().getAttribute('data-agent-id')
    expect(agentId).toMatch(/^agent_/)

    // ── The success half: the project resolves, so the turn reaches the provider check ──────────
    await first.page
      .locator(`[data-agent-id="${agentId}"] [data-testid="agents-list-row-open"]`)
      .click()
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

    await openAgents(first.page)
    await first.page
      .locator(`[data-agent-id="${agentId}"] [data-testid="agents-list-row-open"]`)
      .click()

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
      console.error(`[agent-project-location-e2e] cleanup failed (not a test result): ${String(error)}`)
    })
  }
})
