import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { pickNewAgentProject } from './helpers/new-agent-project-picker'
import { expect, test } from './helpers/orca-app'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'
import { waitForActivePaneHookDescriptor } from './helpers/terminal'
import { RuntimeClient } from '../../src/cli/runtime-client'

// PRODUCT REALITY — a person approves an exact commit in the Workspace, and only that commit.
//
// The gate is created through the product RPC, bound by Orca to the test repository's HEAD. The
// repository then moves, so the Workspace must NOT offer to approve what it was asked about: it
// offers to look at the current commit instead. Approving that one decides the gate in main, which
// the RPC then reports. Locale-free handles only: this host may run Orca in Spanish.

test.setTimeout(300_000)

async function createAgent(page: Page, name: string): Promise<string> {
  await page.getByTestId('workspace-new-agent').click()
  await page.getByTestId('new-agent-name').fill(name)
  await page.getByTestId('new-agent-role').fill('approval probe')
  await pickNewAgentProject(page, 'first')
  await page.getByTestId('new-agent-submit').click()
  await expect(page.getByTestId('new-agent-dialog')).toHaveCount(0)
  await expect(page.getByTestId('agent-chat-name')).toHaveText(name)
  return (await page.getByTestId('agent-chat-header').getAttribute('data-agent-id')) as string
}

async function openAgent(page: Page, name: string): Promise<void> {
  await page.getByTestId('workspace-tab-agents').click()
  await page.getByTestId('workspace-agents').getByText(name, { exact: true }).click()
  await expect(page.getByTestId('agent-chat-name')).toHaveText(name)
}

test('the Workspace approves the commit a person is shown, never one that moved', async ({
  testRepoPath
}, testInfo) => {
  const session = createRestartSession(testInfo)
  try {
    const { app, page } = await session.launch()
    await attachRepoAndOpenTerminal(page, testRepoPath)
    const projectId = await page.evaluate(() => window.__store!.getState().projects[0]!.id)
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(1700, 960)
    })
    const coordinatorPane = await waitForActivePaneHookDescriptor(page)
    await page.locator('[data-workspace-activity="agent-workspace"]').first().click()
    const shipper = await createAgent(page, 'Shipper')
    await createAgent(page, 'Bystander')

    const userDataDir = await app.evaluate(({ app: electronApp }) =>
      electronApp.getPath('userData')
    )
    const client = new RuntimeClient(userDataDir, 30_000, null, null)
    const coordinator = await client.call<{ terminal: { handle: string } }>(
      'terminal.resolvePane',
      {
        paneKey: coordinatorPane.paneKey
      }
    )
    const from = coordinator.result.terminal.handle
    const run = await client.call<{ run: { id: string } }>('orchestration.runCreate', {
      objective: 'approval e2e',
      from
    })
    const task = await client.call<{ task: { id: string } }>('orchestration.taskCreate', {
      spec: 'Ship the change once a person approves it.',
      run: run.result.run.id,
      callerTerminalHandle: from,
      assigneeAgent: shipper
    })
    const created = await client.call<{ gate: { id: string; subject: string } }>(
      'orchestration.gateCreate',
      {
        task: task.result.task.id,
        question: 'Ship this commit?',
        worktree: testRepoPath,
        project: projectId,
        from
      }
    )
    const askedAbout = JSON.parse(created.result.gate.subject) as { revision: string }

    // The repository moves before anyone looks: the gate still asks about the old commit.
    writeFileSync(path.join(testRepoPath, 'approval-e2e.txt'), 'moved\n')
    execFileSync('git', ['add', 'approval-e2e.txt'], { cwd: testRepoPath })
    execFileSync(
      'git',
      ['-c', 'user.email=e2e@test.invalid', '-c', 'user.name=e2e', 'commit', '-qm', 'move'],
      { cwd: testRepoPath }
    )
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: testRepoPath,
      encoding: 'utf8'
    }).trim()
    expect(head).not.toBe(askedAbout.revision)

    await openAgent(page, 'Bystander')
    await openAgent(page, 'Shipper')
    const approval = page.getByTestId('agent-approval')
    await expect(approval).toHaveAttribute('data-state', 'pending', { timeout: 30_000 })
    // No approve button for a commit that is no longer there; the only way forward is to look again.
    await expect(approval.getByRole('button')).toHaveCount(2)
    await approval.getByRole('button').first().click()
    await expect(approval).toHaveAttribute('data-state', 'pending')
    await expect
      .poll(async () => await approval.getByRole('button').first().isEnabled(), { timeout: 30_000 })
      .toBe(true)
    await approval.getByRole('button').first().click()
    await expect(approval).toHaveAttribute('data-state', 'approved', { timeout: 30_000 })

    const gates = await client.call<{
      gates: { id: string; status: string; decision: string | null; subject: string }[]
    }>('orchestration.gateList', { task: task.result.task.id, from })
    const decided = gates.result.gates.find((gate) => gate.id === created.result.gate.id)!
    expect(decided).toMatchObject({ status: 'resolved', decision: 'approved' })
    expect((JSON.parse(decided.subject) as { revision: string }).revision).toBe(head)
    await testInfo.attach('approval-rail', {
      body: await page.getByTestId('agent-context-federation').screenshot(),
      contentType: 'image/png'
    })
    await session.close(app)
  } finally {
    await session.dispose().catch((error: unknown) => {
      console.error(`[agent-federation-e2e] cleanup failed (not a test result): ${String(error)}`)
    })
  }
})
