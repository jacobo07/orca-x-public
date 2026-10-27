import type { Page } from '@stablyai/playwright-test'
import { pickNewAgentProject } from './helpers/new-agent-project-picker'
import { expect, test } from './helpers/orca-app'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'

// PRODUCT REALITY — the Cognitive Workspace surface says what the execution path does.
//
// Two agents in one window, with a repository attached and active the whole time:
//   Ledger   bound to that repository's project
//   Drifter  bound to no project
//
// The header chip, location chip and context rail must come from each AGENT, not from what the
// window is showing. Drifter is the discriminating case: the active repository is right there, so a
// surface that derived "project" from the UI's active repo would show it for Drifter too.
//
// The location claim is checked against the turn itself. With no provider credential, a turn whose
// location resolved reaches `auth-required`; so the ready chip is paired with that outcome, and the
// credential row must agree with it. Locale-free handles only: this host runs Orca in Spanish.

test.setTimeout(300_000)

async function createAgent(
  page: Page,
  name: string,
  projectIndex: 'first' | 'none'
): Promise<string> {
  await page.getByTestId('workspace-new-agent').click()
  await page.getByTestId('new-agent-name').fill(name)
  await page.getByTestId('new-agent-role').fill('reality probe')
  await pickNewAgentProject(page, projectIndex)
  await page.getByTestId('new-agent-submit').click()
  await expect(page.getByTestId('new-agent-dialog')).toHaveCount(0)
  // The dialog opens the new agent's chat; the header names who it is.
  const header = page.getByTestId('agent-chat-header')
  await expect(page.getByTestId('agent-chat-name')).toHaveText(name)
  const id = await header.getAttribute('data-agent-id')
  expect(id).toMatch(/^agent_/)
  return id as string
}

test('the workspace grounds each agent in its own project and in the turn runner’s answer', async ({
  testRepoPath
}, testInfo) => {
  const session = createRestartSession(testInfo)
  try {
    const { app, page } = await session.launch()
    await attachRepoAndOpenTerminal(page, testRepoPath)
    const activeProject = await page.evaluate(() => {
      const state = window.__store!.getState()
      return state.projects.map((project) => ({ id: project.id, name: project.displayName }))
    })
    expect(activeProject.length).toBeGreaterThan(0)

    // Wide enough for all three columns beside Orca's own side panel.
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(1700, 960)
    })
    await page.locator('[data-workspace-activity="agent-workspace"]').first().click()
    await expect(page.getByTestId('workspace-roster')).toBeVisible()
    await expect(page.getByTestId('conversations-page')).toHaveAttribute(
      'data-workspace-layout',
      'wide'
    )

    const ledger = await createAgent(page, 'Ledger', 'first')
    await expect(page.getByTestId('agent-chat-project-chip')).toHaveAttribute(
      'data-project-kind',
      'project'
    )
    await expect(page.getByTestId('agent-chat-project-chip')).toContainText(activeProject[0].name)
    await expect(page.getByTestId('agent-chat-location-chip')).toHaveAttribute(
      'data-outcome',
      'resolved'
    )
    await expect(page.getByTestId('agent-context-location')).toHaveAttribute(
      'data-state',
      'resolved'
    )
    await expect(page.getByTestId('agent-context-location')).toContainText(testRepoPath)
    const credential = await page.getByTestId('agent-context-credential').getAttribute('data-state')
    expect(['ready', 'not-ready']).toContain(credential)

    // The claim meets the runner: a resolved location reaches the credential gate.
    await page.getByTestId('conversation-composer').fill('What is in this repository?')
    await page.getByTestId('conversation-send').click()
    const notice = page.getByTestId('conversation-notice')
    if (credential === 'not-ready') {
      await expect(notice).toHaveAttribute('data-notice-kind', 'auth-required', { timeout: 30_000 })
    }
    await expect(page.getByTestId('agent-context-threads')).toHaveText('1', { timeout: 30_000 })

    // Drifter: no project, while the repository above is still attached and active.
    const drifter = await createAgent(page, 'Drifter', 'none')
    expect(drifter).not.toBe(ledger)
    await expect(page.getByTestId('agent-chat-project-chip')).toHaveAttribute(
      'data-project-kind',
      'none'
    )
    await expect(page.getByTestId('agent-chat-location-chip')).toHaveAttribute(
      'data-outcome',
      'no-project'
    )
    await expect(page.getByTestId('agent-context-project-name')).toHaveAttribute(
      'data-state',
      'none'
    )

    // A thread picked from another agent's scope opens in its own agent's scope.
    await page.getByTestId('workspace-tab-threads').click()
    await page.getByTestId('conversations-list-row').first().click()
    await expect(page.getByTestId('agent-chat-header')).toHaveAttribute('data-agent-id', ledger)
    await expect(page.getByText('What is in this repository?').first()).toBeVisible()

    // Visual evidence, dark first because the references are dark; the mode is asserted, never
    // assumed (e2e launches resolve to light).
    for (const theme of ['dark', 'light'] as const) {
      await page.evaluate(async (value) => {
        await window.__store!.getState().updateSettingsOrThrow({ theme: value })
      }, theme)
      await expect
        .poll(() => page.evaluate(() => document.documentElement.classList.contains('dark')))
        .toBe(theme === 'dark')
      for (const width of [1536, 1024]) {
        await app.evaluate(({ BrowserWindow }, size) => {
          BrowserWindow.getAllWindows()[0]?.setSize(size, 960)
        }, width)
        await page.waitForTimeout(400)
        // Regression: at a 1024px window the chat column once reached zero width.
        const composerWidth = (await page.getByTestId('conversation-composer').boundingBox())?.width
        expect(composerWidth ?? 0).toBeGreaterThan(320)
        await page.screenshot({ path: testInfo.outputPath(`workspace-${theme}-${width}.png`) })
      }
    }

    await session.close(app)
  } finally {
    await session.dispose().catch((error: unknown) => {
      console.error(
        `[cognitive-workspace-e2e] cleanup failed (not a test result): ${String(error)}`
      )
    })
  }
})
