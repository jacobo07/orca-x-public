/**
 * Product reality for a manually slept workspace: Sleep from the workspace menu releases every
 * terminal, and coming back — by navigation, by selecting rows, or after a relaunch — starts
 * nothing until the placeholder's Open is pressed, one row per click.
 *
 * Absence is proven by session id, not count: every main session that appears after the sleep
 * must belong to a row that was explicitly opened.
 *
 * Not covered: the resumed agent is `echo` (the fixture points codex at it), so this proves the
 * row opens through its sleeping record, not that a real provider continued its conversation.
 */
import { existsSync, readFileSync } from 'node:fs'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { TEST_REPO_PATH_FILE } from './global-setup'
import { waitForActiveTerminalManager, waitForPaneCount } from './helpers/terminal'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'
import { worktreeRowSurface } from './worktree-row-locators'

const PROVIDER_SESSION_ID = 'e2e-workspace-sleep-dormancy-session'

async function rowIds(page: Page, worktreeId: string): Promise<string[]> {
  return page.evaluate(
    (wt) => (window.__store!.getState().tabsByWorktree[wt] ?? []).map((tab) => tab.id),
    worktreeId
  )
}

/**
 * Rows with a process main actually lists. A slept tab can carry its old PTY id as a wake hint
 * after a relaunch, so the renderer's binding alone is not evidence that anything runs.
 */
async function liveRowIds(page: Page, worktreeId: string): Promise<string[]> {
  return page.evaluate(async (wt) => {
    const listed = new Set((await window.api.pty.listSessions()).map((session) => session.id))
    const s = window.__store!.getState()
    return (s.tabsByWorktree[wt] ?? [])
      .map((tab) => tab.id)
      .filter((id) => (s.ptyIdsByTabId[id] ?? []).some((ptyId) => listed.has(ptyId)))
  }, worktreeId)
}

async function dormancyReasons(page: Page, worktreeId: string): Promise<(string | null)[]> {
  return page.evaluate(
    (wt) =>
      (window.__store!.getState().tabsByWorktree[wt] ?? []).map(
        (tab) => tab.dormancy?.reason ?? null
      ),
    worktreeId
  )
}

async function mainSessionIds(page: Page): Promise<string[]> {
  return page.evaluate(async () =>
    (await window.api.pty.listSessions()).map((session) => session.id).sort()
  )
}

async function showWorkspaceList(page: Page, worktreeId: string): Promise<void> {
  // Docked left, the side panel and the workspace list are alternatives.
  await page.evaluate(() => {
    const s = window.__store!.getState()
    s.setRightSidebarOpen(false)
    s.setSidebarOpen(true)
  })
  await expect(worktreeRowSurface(page, worktreeId)).toBeVisible({ timeout: 30_000 })
}

async function enterWorkspace(page: Page, worktreeId: string): Promise<void> {
  await showWorkspaceList(page, worktreeId)
  await worktreeRowSurface(page, worktreeId).click()
  await waitForActiveWorktree(page)
  await ensureTerminalVisible(page)
}

async function selectRow(page: Page, worktreeId: string, tabId: string): Promise<void> {
  await page.evaluate(
    ({ wt, id }) => {
      const s = window.__store!.getState()
      s.activateTab(id, { worktreeId: wt })
      s.setActiveTab(id)
    },
    { wt: worktreeId, id: tabId }
  )
  await expect(page.getByTestId('dormant-terminal-placeholder')).toHaveAttribute(
    'data-dormant-terminal-tab-id',
    tabId,
    { timeout: 15_000 }
  )
}

/** Every sample: exactly `live` rows have a process, and every new main session belongs to one. */
async function expectHeldFor(
  page: Page,
  worktreeId: string,
  expected: { live: string[]; baseline: string[] }
): Promise<void> {
  const violations: string[] = []
  for (let sample = 0; sample < 16; sample++) {
    const live = await liveRowIds(page, worktreeId)
    if (JSON.stringify([...live].sort()) !== JSON.stringify([...expected.live].sort())) {
      violations.push(`sample ${sample}: live rows ${JSON.stringify(live)}`)
    }
    const stray = await page.evaluate(
      async ({ baseline, opened }) => {
        const s = window.__store!.getState()
        const allowed = new Set(opened.flatMap((id) => s.ptyIdsByTabId[id] ?? []))
        const known = new Set(baseline)
        return (await window.api.pty.listSessions())
          .map((session) => session.id)
          .filter((id) => !known.has(id) && !allowed.has(id))
      },
      { baseline: expected.baseline, opened: expected.live }
    )
    if (stray.length > 0) {
      violations.push(`sample ${sample}: main sessions not bound to an opened row ${stray}`)
    }
    await page.waitForTimeout(250)
  }
  expect(violations).toEqual([])
}

test.describe.configure({ mode: 'serial' })

test('a workspace slept from its menu stays asleep through navigation, selection and relaunch', async (// oxlint-disable-next-line no-empty-pattern -- Playwright's second fixture arg is testInfo; the first must be an object destructure to opt out of the default fixture set.
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
    await page.evaluate(() =>
      window.__store!.getState().updateSettings({ agentCmdOverrides: { codex: 'echo' } })
    )

    await page.evaluate((wt) => {
      window.__store!.getState().createTab(wt, undefined, 'cmd.exe', {
        launchProfileId: 'shell:cmd.exe'
      })
    }, worktreeId)
    await expect
      .poll(() => liveRowIds(page, worktreeId), {
        timeout: 30_000,
        message: 'both rows running before the sleep'
      })
      .toHaveLength(2)
    const ids = await rowIds(page, worktreeId)
    const transcriptPath = session.seedCodexResumeRollout(PROVIDER_SESSION_ID, repoPath)
    await page.evaluate(
      ({ wt, tabId, id, transcriptPath: path }) => {
        const s = window.__store!.getState()
        const root = s.terminalLayoutsByTabId[tabId]?.root
        const leafId = root?.type === 'leaf' ? root.leafId : null
        if (!leafId) {
          throw new Error('row 0 has no single leaf')
        }
        s.setAgentStatus(
          `${tabId}:${leafId}`,
          { state: 'done', prompt: '', agentType: 'codex' },
          'Codex',
          undefined,
          { worktreeId: wt, tabId },
          { providerSession: { key: 'session_id', id, transcriptPath: path } }
        )
      },
      { wt: worktreeId, tabId: ids[0], id: PROVIDER_SESSION_ID, transcriptPath }
    )
    const liveBeforeSleep = await page.evaluate(
      (tabIds) => tabIds.flatMap((id) => window.__store!.getState().ptyIdsByTabId[id] ?? []),
      ids
    )

    // Sleep through the workspace menu.
    await showWorkspaceList(page, worktreeId)
    await worktreeRowSurface(page, worktreeId).click({ button: 'right' })
    await page.getByTestId('worktree-menu-sleep').click()
    await expect
      .poll(() => liveRowIds(page, worktreeId), {
        timeout: 45_000,
        message: 'sleep released every row'
      })
      .toEqual([])
    expect(await dormancyReasons(page, worktreeId)).toEqual(['workspace-sleep', 'workspace-sleep'])
    await expect
      .poll(async () => (await mainSessionIds(page)).filter((id) => liveBeforeSleep.includes(id)), {
        timeout: 30_000,
        message: 'the host no longer lists the slept sessions'
      })
      .toEqual([])
    const sleptSessions = await page.evaluate(
      (tabIds) =>
        Object.values(window.__store!.getState().sleepingAgentSessionsByPaneKey)
          .filter((record) => record.tabId && tabIds.includes(record.tabId))
          .map((record) => record.tabId),
      ids
    )
    expect(sleptSessions).toEqual([ids[0]])

    // Coming back starts nothing.
    const baseline = await mainSessionIds(page)
    await enterWorkspace(page, worktreeId)
    await expect(page.getByTestId('dormant-terminal-placeholder')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('dormant-terminal-placeholder')).toHaveAttribute(
      'data-dormancy-reason',
      'workspace-sleep'
    )
    await expectHeldFor(page, worktreeId, { live: [], baseline })
    for (const id of ids) {
      await selectRow(page, worktreeId, id)
    }
    await expectHeldFor(page, worktreeId, { live: [], baseline })

    // Only Open starts a row.
    await selectRow(page, worktreeId, ids[1])
    await page.getByTestId('dormant-terminal-open').click()
    await expect
      .poll(() => liveRowIds(page, worktreeId), {
        timeout: 45_000,
        message: 'only the opened row acquired a process'
      })
      .toEqual([ids[1]])
    await expectHeldFor(page, worktreeId, { live: [ids[1]], baseline })
    expect(await dormancyReasons(page, worktreeId)).toEqual(['workspace-sleep', null])

    await session.close(firstApp)
    firstApp = null

    // A relaunch keeps the unopened row asleep.
    const second = await session.launch()
    secondApp = second.app
    const page2 = second.page
    await waitForSessionReady(page2)
    await page2.evaluate(() =>
      window.__store!.getState().updateSettings({ agentCmdOverrides: { codex: 'echo' } })
    )
    expect(await dormancyReasons(page2, worktreeId)).toEqual(['workspace-sleep', null])
    const baseline2 = await mainSessionIds(page2)
    await enterWorkspace(page2, worktreeId)
    await selectRow(page2, worktreeId, ids[0])
    await expect(page2.getByTestId('dormant-terminal-placeholder')).toBeVisible()
    const liveAfterRelaunch = await liveRowIds(page2, worktreeId)
    expect(liveAfterRelaunch).not.toContain(ids[0])
    await expectHeldFor(page2, worktreeId, { live: liveAfterRelaunch, baseline: baseline2 })

    await page2.getByTestId('dormant-terminal-open').click()
    await expect
      .poll(async () => (await liveRowIds(page2, worktreeId)).includes(ids[0]), {
        timeout: 45_000,
        message: 'the agent row opened after relaunch'
      })
      .toBe(true)
    const openedSessions = await page2.evaluate(
      (id) => window.__store!.getState().ptyIdsByTabId[id] ?? [],
      ids[0]
    )
    expect(openedSessions).toHaveLength(1)
    expect(baseline2).not.toContain(openedSessions[0])
    expect(await dormancyReasons(page2, worktreeId)).toEqual([null, null])

    console.log(
      `[workspace-sleep-evidence] rows=${ids.length} sleptLive=${liveBeforeSleep.length} ` +
        `baselineAfterSleep=${baseline.length} liveAfterRelaunch=${liveAfterRelaunch.length}`
    )
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
