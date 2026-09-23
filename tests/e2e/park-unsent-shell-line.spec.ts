/**
 * Product reality for Park and an unsent shell line: a line typed at an idle prompt, which the
 * renderer no longer knows about after a reload, keeps its workspace. Workspace Sleep has no input
 * check of its own, so the plan is the only thing standing between Park and the lost line.
 *
 * The line is written straight to the host, so the renderer never sees it — the state a reload
 * leaves behind — and the renderer is then reloaded as well. The control clears the line and
 * requires the same workspace to become sleepable.
 */
import { existsSync, readFileSync } from 'node:fs'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { TEST_REPO_PATH_FILE } from './global-setup'
import { waitForActiveTerminalManager, waitForPaneCount } from './helpers/terminal'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'

type ParkOutcome = { worktreeId: string; outcome: string; reasons?: string[] }
type Park = { status: string; exiting: boolean; workspaces: ParkOutcome[] }

async function park(page: Page, mode: 'plan' | 'park'): Promise<Park> {
  return page.evaluate(
    (m) => window.api.durableExit.park({ mode: m, includePinned: false }),
    mode
  ) as Promise<Park>
}

async function hostInput(page: Page, ptyId: string): Promise<unknown> {
  return (await page.evaluate((id) => window.api.pty.inspectProcess(id), ptyId)).inputSincePrompt
}

async function listed(page: Page): Promise<string[]> {
  return page.evaluate(async () => (await window.api.pty.listSessions()).map((s) => s.id))
}

test('an unsent shell line the renderer lost across a reload keeps Park from sleeping it', async (// oxlint-disable-next-line no-empty-pattern -- Playwright's second fixture arg is testInfo; the first must be an object destructure to opt out of the default fixture set.
{}, testInfo) => {
  const repoPath = readFileSync(TEST_REPO_PATH_FILE, 'utf-8').trim()
  if (!repoPath || !existsSync(repoPath)) {
    test.skip(true, 'Global setup did not produce a seeded test repo')
    return
  }
  const session = createRestartSession(testInfo)
  let app: ElectronApplication | null = null
  try {
    const launched = await session.launch()
    app = launched.app
    const page = await app.firstWindow()
    const worktreeId = await attachRepoAndOpenTerminal(page, repoPath)
    await waitForSessionReady(page)
    await waitForActiveWorktree(page)
    await ensureTerminalVisible(page)
    await waitForActiveTerminalManager(page, 30_000)
    await waitForPaneCount(page, 1, 30_000)
    const readPtyId = (): Promise<string | null> =>
      page.evaluate((wt) => {
        const s = window.__store!.getState()
        const tabId = s.tabsByWorktree[wt]?.[0]?.id
        return tabId ? (s.ptyIdsByTabId[tabId]?.[0] ?? null) : null
      }, worktreeId)
    await expect
      .poll(readPtyId, { timeout: 30_000, message: 'the shell registered its PTY' })
      .toBeTruthy()
    const ptyId = await readPtyId()
    await expect
      .poll(
        async () =>
          (await page.evaluate((id) => window.api.pty.inspectProcess(id), ptyId!)).promptState,
        {
          timeout: 30_000,
          message: 'the shell reached its prompt'
        }
      )
      .toBe('prompt')

    // Precondition: the host itself vouches for the line, so the refusal below is about it.
    await page.evaluate((id) => window.api.pty.write(id, 'echo park-draft-line'), ptyId!)
    await expect
      .poll(() => hostInput(page, ptyId!), { timeout: 30_000, message: 'the host saw the line' })
      .toBe('typed')

    await page.reload()
    await waitForSessionReady(page)
    expect(
      await page.evaluate((wt) => {
        const s = window.__store!.getState()
        const tabId = s.tabsByWorktree[wt]?.[0]?.id ?? ''
        return Object.keys(s.terminalInputPendingByPaneKey).some((key) => key.startsWith(tabId))
      }, worktreeId),
      'the reloaded renderer holds no record of the line'
    ).toBe(false)
    expect(await hostInput(page, ptyId!)).toBe('typed')

    const refused = await park(page, 'park')
    expect(refused.status).toBe('refused')
    expect(refused.exiting).toBe(false)
    expect(refused.workspaces).toContainEqual(
      expect.objectContaining({ worktreeId, outcome: 'kept', reasons: ['unsent-input'] })
    )
    expect(await listed(page)).toContain(ptyId)

    // Control: with the line cleared the same workspace is sleepable, so the refusal was the line.
    await page.evaluate((id) => window.api.pty.write(id, '\x03'), ptyId!)
    await expect
      .poll(() => hostInput(page, ptyId!), { timeout: 30_000, message: 'the line was cleared' })
      .toBe('clean')
    const plan = await park(page, 'plan')
    expect(plan.status).toBe('planned')
    expect(plan.workspaces).toContainEqual(
      expect.objectContaining({ worktreeId, outcome: 'would-sleep' })
    )
    console.log(`[park-draft-evidence] refused=${refused.status} control=${plan.status}`)
  } finally {
    if (app) {
      await session.close(app)
    }
    await session.dispose()
  }
})
