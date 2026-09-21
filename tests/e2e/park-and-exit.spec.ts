/**
 * Product reality for Park and Exit (docs/reference/durable-park-and-exit.md):
 * - a plan changes nothing;
 * - a shell running a command refuses the whole park and nothing is released;
 * - once idle, the app menu's "Sleep Everything and Exit" sleeps every row, saves, and quits;
 * - the relaunch finds no surviving session, every row dormant, and Open starts exactly one.
 *
 * "No surviving session" is read from the relaunched daemon's own inventory: a session that
 * outlived the quit would be listed there. The daemon process itself is not inspected.
 */
import { existsSync, readFileSync } from 'node:fs'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { TEST_REPO_PATH_FILE } from './global-setup'
import { waitForActiveTerminalManager, waitForPaneCount } from './helpers/terminal'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'

type Park = { status: string; exiting: boolean; workspaces: { outcome: string }[] }

async function liveRowIds(page: Page, worktreeId: string): Promise<string[]> {
  return page.evaluate(async (wt) => {
    const listed = new Set((await window.api.pty.listSessions()).map((session) => session.id))
    const s = window.__store!.getState()
    return (s.tabsByWorktree[wt] ?? [])
      .map((tab) => tab.id)
      .filter((id) => (s.ptyIdsByTabId[id] ?? []).some((ptyId) => listed.has(ptyId)))
  }, worktreeId)
}

async function park(page: Page, mode: 'plan' | 'park'): Promise<Park> {
  return page.evaluate(
    (m) => window.api.durableExit.park({ mode: m, includePinned: false }),
    mode
  ) as Promise<Park>
}

test.describe.configure({ mode: 'serial' })

test('parks every terminal from the app menu, quits, and relaunches with nothing running', async (// oxlint-disable-next-line no-empty-pattern -- Playwright's second fixture arg is testInfo; the first must be an object destructure to opt out of the default fixture set.
{}, testInfo) => {
  const repoPath = readFileSync(TEST_REPO_PATH_FILE, 'utf-8').trim()
  if (!repoPath || !existsSync(repoPath)) {
    test.skip(true, 'Global setup did not produce a seeded test repo')
    return
  }
  const session = createRestartSession(testInfo)
  let firstApp: ElectronApplication | null = null
  let secondApp: ElectronApplication | null = null
  try {
    const first = await session.launch()
    firstApp = first.app
    const page = await firstApp.firstWindow()
    const worktreeId = await attachRepoAndOpenTerminal(page, repoPath)
    await waitForSessionReady(page)
    await waitForActiveWorktree(page)
    await ensureTerminalVisible(page)
    await waitForActiveTerminalManager(page, 30_000)
    await waitForPaneCount(page, 1, 30_000)
    await page.evaluate((wt) => {
      window.__store!.getState().createTab(wt)
    }, worktreeId)
    await expect
      .poll(() => liveRowIds(page, worktreeId), { timeout: 30_000, message: 'two live rows' })
      .toHaveLength(2)
    const ids = await page.evaluate(
      (wt) => (window.__store!.getState().tabsByWorktree[wt] ?? []).map((tab) => tab.id),
      worktreeId
    )
    const busyPty = await page.evaluate(
      (tabId) => window.__store!.getState().ptyIdsByTabId[tabId]?.[0] ?? null,
      ids[1]
    )
    expect(busyPty).toBeTruthy()

    // A plan changes nothing.
    const plan = await park(page, 'plan')
    expect(plan.status).toBe('planned')
    expect(plan.exiting).toBe(false)
    expect((await liveRowIds(page, worktreeId)).sort()).toEqual([...ids].sort())

    // A shell running a command keeps the whole park from happening. Idle is the shell's own word:
    // on Windows the child-process probe missed a running ping.
    await page.evaluate((id) => window.api.pty.write(id, 'ping -n 600 127.0.0.1\r'), busyPty!)
    await expect
      .poll(
        async () =>
          (await page.evaluate((id) => window.api.pty.inspectProcess(id), busyPty!)).promptState,
        { timeout: 30_000, message: 'the shell says a command is running' }
      )
      .toBe('running')
    const refused = await park(page, 'park')
    expect(refused.status).toBe('refused')
    expect(refused.exiting).toBe(false)
    expect((await liveRowIds(page, worktreeId)).sort()).toEqual([...ids].sort())

    // Stop the child, then park from the real app menu.
    await page.evaluate((id) => window.api.pty.write(id, '\x03'), busyPty!)
    await expect
      .poll(
        async () =>
          (await page.evaluate((id) => window.api.pty.inspectProcess(id), busyPty!)).promptState,
        { timeout: 30_000, message: 'the shell is back at its prompt' }
      )
      .toBe('prompt')
    const closed = new Promise<void>((resolve) => firstApp!.once('close', () => resolve()))
    await firstApp.evaluate(({ Menu }) => {
      Menu.getApplicationMenu()?.getMenuItemById('park-and-exit')?.click()
    })
    await Promise.race([
      closed,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('the app did not quit after parking')), 90_000)
      )
    ])
    firstApp = null

    const second = await session.launch()
    secondApp = second.app
    const page2 = second.page
    await waitForSessionReady(page2)
    const state = await page2.evaluate(
      async ({ wt }) => {
        const s = window.__store!.getState()
        return {
          dormancy: (s.tabsByWorktree[wt] ?? []).map((tab) => [
            tab.id,
            tab.dormancy?.reason ?? null
          ]),
          sessions: (await window.api.pty.listSessions()).map((listed) => listed.id)
        }
      },
      { wt: worktreeId }
    )
    expect(state.dormancy).toEqual(ids.map((id) => [id, 'workspace-sleep']))
    expect(state.sessions).toEqual([])

    await page2.evaluate(
      ({ wt, id }) => {
        const s = window.__store!.getState()
        s.setActiveWorktree(wt)
        s.activateTab(id, { worktreeId: wt })
        s.setActiveTab(id)
      },
      { wt: worktreeId, id: ids[1] }
    )
    await ensureTerminalVisible(page2)
    await expect(page2.getByTestId('dormant-terminal-placeholder')).toBeVisible({ timeout: 30_000 })
    expect(await liveRowIds(page2, worktreeId)).toEqual([])
    await page2.getByTestId('dormant-terminal-open').click()
    await expect
      .poll(() => liveRowIds(page2, worktreeId), { timeout: 45_000, message: 'one row opened' })
      .toEqual([ids[1]])
    expect(await page2.evaluate(async () => (await window.api.pty.listSessions()).length)).toBe(1)
    console.log(`[park-evidence] rows=${ids.length} plan=${plan.status} refused=${refused.status}`)
  } finally {
    if (secondApp) {
      await session.close(secondApp)
    }
    if (firstApp) {
      await session.close(firstApp)
    }
    await session.dispose()
  }
})
