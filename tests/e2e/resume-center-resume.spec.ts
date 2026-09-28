import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { TEST_REPO_PATH_FILE } from './global-setup'
import { waitForActiveTerminalManager } from './helpers/terminal'
import {
  ensureTerminalVisible,
  switchToOtherWorktree,
  switchToWorktree,
  waitForActiveWorktree,
  waitForSessionReady
} from './helpers/store'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'
import { PROTOCOL_VERSION } from '../../src/main/daemon/types'

/**
 * Resume and Resume all, in a running Orca, judged by the host's own session list.
 *
 * A background worktree keeps three terminal rows whose processes died with the daemon. Admission
 * reads a scripted free-memory sequence (9 GB, 9 GB, then 100 bytes) through the e2e-only reading,
 * so the refusal is real admission logic without real pressure on the host:
 *   restore only  -> nothing starts
 *   Resume row A  -> exactly one new session, and it is A's
 *   Resume all    -> B starts, C is refused and stays asleep; the page says paused, 1 left
 *   Continue      -> asked again, refused again, nothing starts
 * An implementation that fans out, or that ignores admission, starts C and fails.
 */

const GB9 = 9_000_000_000
const OBSERVE_MS = 6_000

function readDaemonPid(userDataDir: string): number {
  const raw = readFileSync(
    path.join(userDataDir, 'daemon', `daemon-v${PROTOCOL_VERSION}.pid`),
    'utf8'
  )
  return (JSON.parse(raw) as { pid: number }).pid
}

async function hostSessionIds(page: Page): Promise<string[]> {
  return page.evaluate(async () =>
    (await window.api.pty.listSessions()).map((session) => session.id).sort()
  )
}

async function quiescedHost(page: Page): Promise<string[]> {
  let previous = await hostSessionIds(page)
  let stable = 0
  for (let attempt = 0; attempt < 40 && stable < 3; attempt++) {
    await page.waitForTimeout(250)
    const current = await hostSessionIds(page)
    stable = JSON.stringify(current) === JSON.stringify(previous) ? stable + 1 : 0
    previous = current
  }
  expect(stable, 'host session list never quiesced').toBeGreaterThanOrEqual(3)
  return previous
}

/** New host sessions over a window, so a late spawn is seen rather than raced past. */
async function newSessionsOver(page: Page, baseline: string[], ms: number): Promise<string[]> {
  const known = new Set(baseline)
  const seen = new Set<string>()
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    for (const id of await hostSessionIds(page)) {
      if (!known.has(id)) {
        seen.add(id)
      }
    }
    await page.waitForTimeout(250)
  }
  return [...seen].sort()
}

async function openResumeCenter(page: Page): Promise<void> {
  await page.locator('[data-workspace-activity="agent-workspace"]').first().click()
  await page.getByTestId('workspace-open-resume-center').click()
  await expect(page.getByTestId('resume-center-page')).toBeVisible({ timeout: 15_000 })
}

type Row = { tabId: string; dormancy: string | null; boundIds: string[] }

async function readRows(page: Page, worktreeId: string): Promise<Row[]> {
  return page.evaluate((wt) => {
    const s = window.__store!.getState()
    return (s.tabsByWorktree[wt] ?? []).map((tab) => ({
      tabId: tab.id,
      dormancy: tab.dormancy?.reason ?? null,
      boundIds: [tab.ptyId, ...(s.ptyIdsByTabId[tab.id] ?? [])].filter(
        (id): id is string => typeof id === 'string'
      )
    }))
  }, worktreeId)
}

test.describe.configure({ mode: 'serial' })
test.setTimeout(300_000)

test('Resume wakes exactly the chosen row, and Resume all stops at admission', async (// oxlint-disable-next-line no-empty-pattern -- Playwright's second fixture arg is testInfo; the first must be an object destructure to opt out of the default fixture set.
{}, testInfo) => {
  const repoPath = readFileSync(TEST_REPO_PATH_FILE, 'utf-8').trim()
  if (!repoPath || !existsSync(repoPath)) {
    test.skip(true, 'Global setup did not produce a seeded test repo')
    return
  }
  test.skip(process.platform === 'win32', 'Uses POSIX SIGKILL to simulate daemon death')

  const session = createRestartSession(testInfo, {
    ORCA_E2E_WAKE_AVAILABLE_BYTES: `${GB9},${GB9},100`
  })
  let firstApp: ElectronApplication | null = null
  let secondApp: ElectronApplication | null = null
  try {
    const first = await session.launch()
    firstApp = first.app
    const page = first.page
    const home = await attachRepoAndOpenTerminal(page, repoPath)
    await waitForSessionReady(page)
    await waitForActiveWorktree(page)
    await ensureTerminalVisible(page)
    await waitForActiveTerminalManager(page, 30_000)

    const target = (await switchToOtherWorktree(page, home)) as string
    expect(target, 'no second worktree').toBeTruthy()
    await ensureTerminalVisible(page)
    await waitForActiveTerminalManager(page, 30_000)
    await page.evaluate((wt) => {
      const s = window.__store!.getState()
      s.createTab(wt)
      s.createTab(wt)
    }, target)
    await expect
      .poll(
        async () => (await readRows(page, target)).filter((r) => r.boundIds.length > 0).length,
        {
          timeout: 30_000,
          message: 'the three seeded rows never all started'
        }
      )
      .toBe(3)
    await switchToWorktree(page, home)

    const daemonPid = readDaemonPid(session.userDataDir)
    await session.close(firstApp)
    firstApp = null
    // ESRCH: on Windows the daemon is already gone after quit; the no-process residency proves it.
    try {
      process.kill(daemonPid, 'SIGKILL')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
        throw error
      }
    }

    const second = await session.launch()
    secondApp = second.app
    const app = second.page
    await waitForSessionReady(app)
    await expect
      .poll(async () => app.evaluate(() => window.__store?.getState().activeWorktreeId), {
        timeout: 15_000
      })
      .toBe(home)
    await ensureTerminalVisible(app)
    await waitForActiveTerminalManager(app, 30_000)
    const tabIds = (await readRows(app, target)).map((r) => r.tabId)
    expect(tabIds.length, 'the target lost rows across the restart').toBe(3)
    const [rowA, rowB, rowC] = tabIds as [string, string, string]

    // 1. Restore only: the rows come back and nothing starts.
    await openResumeCenter(app)
    const section = app.locator(
      `[data-testid="resume-center-workspace"][data-workspace-key="${target}"]`
    )
    await expect(section).toBeVisible({ timeout: 30_000 })
    const beforeRestore = await quiescedHost(app)
    await section.getByTestId('resume-center-workspace-open').click()
    expect(
      await newSessionsOver(app, beforeRestore, OBSERVE_MS),
      'restore only started a session'
    ).toEqual([])
    expect((await readRows(app, target)).map((r) => r.dormancy)).toEqual([
      'layout-restore',
      'layout-restore',
      'layout-restore'
    ])

    // 2. Resume row A: exactly one new host session, and it is A's.
    await openResumeCenter(app)
    const beforeA = await quiescedHost(app)
    await app
      .locator(`[data-testid="resume-center-tab-row"][data-tab-id="${rowA}"]`)
      .getByTestId('resume-center-tab-resume')
      .click()
    await expect
      .poll(async () => (await readRows(app, target)).find((r) => r.tabId === rowA)?.dormancy, {
        timeout: 60_000,
        message: 'row A never bound a PTY'
      })
      .toBeNull()
    const afterA = await newSessionsOver(app, beforeA, OBSERVE_MS)
    const rowsAfterA = await readRows(app, target)
    const aIds = rowsAfterA.find((r) => r.tabId === rowA)!.boundIds
    expect(afterA.length, `Resume A started ${afterA.length} sessions: ${afterA}`).toBe(1)
    expect(aIds, 'the session that started is not row A').toContain(afterA[0])
    expect(rowsAfterA.filter((r) => r.tabId !== rowA).map((r) => r.dormancy)).toEqual([
      'layout-restore',
      'layout-restore'
    ])

    // 3. Resume all: B is admitted, C is refused and stays asleep.
    await openResumeCenter(app)
    const beforeAll = await quiescedHost(app)
    await app.getByTestId('resume-center-resume-all-start').click()
    await expect
      .poll(async () => (await readRows(app, target)).find((r) => r.tabId === rowB)?.dormancy, {
        timeout: 60_000,
        message: 'row B never bound a PTY'
      })
      .toBeNull()
    const afterAll = await newSessionsOver(app, beforeAll, OBSERVE_MS)
    const rowsAfterAll = await readRows(app, target)
    expect(afterAll.length, `Resume all started ${afterAll.length} sessions: ${afterAll}`).toBe(1)
    expect(rowsAfterAll.find((r) => r.tabId === rowB)!.boundIds).toContain(afterAll[0])
    expect(rowsAfterAll.find((r) => r.tabId === rowC)!.dormancy, 'row C woke past a refusal').toBe(
      'layout-restore'
    )
    await openResumeCenter(app)
    const status = app.getByTestId('resume-center-resume-all-status')
    await expect(status).toHaveAttribute('data-status', 'stopped', { timeout: 15_000 })
    await expect(app.getByTestId('resume-center-resume-all-remaining')).toHaveText('1')
    await expect(app.getByTestId('resume-center-resume-all-started')).toHaveText('1')

    // 4. Continue asks again; the reading is still below the floor, so nothing starts.
    const beforeContinue = await quiescedHost(app)
    await app.getByTestId('resume-center-resume-all-continue').click()
    await expect(status).toHaveAttribute('data-status', 'stopped', { timeout: 30_000 })
    expect(
      await newSessionsOver(app, beforeContinue, OBSERVE_MS),
      'Continue started a session'
    ).toEqual([])
    expect((await readRows(app, target)).find((r) => r.tabId === rowC)!.dormancy).toBe(
      'layout-restore'
    )
    await app.screenshot({ path: 'pr-evidence/resume-center-resume-all-paused.png' })
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
