import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { TEST_REPO_PATH_FILE } from './global-setup'
import {
  execInTerminal,
  waitForActivePaneHookDescriptor,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForPaneCount,
  waitForTerminalOutput
} from './helpers/terminal'
import {
  ensureTerminalVisible,
  switchToOtherWorktree,
  switchToWorktree,
  waitForActiveWorktree,
  waitForSessionReady
} from './helpers/store'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'
import { PROTOCOL_VERSION } from '../../src/main/daemon/types'
import { DEFAULT_LOCAL_ORCA_PROFILE_ID } from '../../src/shared/orca-profiles'

/**
 * Restore layout only, in a running Orca: opening a remembered workspace from the Resume Center
 * brings its rows back and starts nothing.
 *
 * The subject is a background workspace whose terminal lost its process while the app was closed
 * (daemon killed) and whose pane carries a resumable agent record. Opening it the ordinary way mounts
 * the tab, spawns a shell and types the resume command. The Resume Center's open must not.
 *
 * Judged by the host's own session list from main, not by the rendered rows: a restore that looks
 * right while a PTY starts behind it is exactly the failure this exists to catch.
 */

const PROVIDER_SESSION_ID = 'e2e-restore-no-wake-session'
const OBSERVE_AFTER_OPEN_MS = 8_000

function stubPersistedResumeCommand(userDataDir: string): void {
  const dataPath = path.join(
    userDataDir,
    'profiles',
    DEFAULT_LOCAL_ORCA_PROFILE_ID,
    'orca-data.json'
  )
  const data = JSON.parse(readFileSync(dataPath, 'utf8')) as {
    workspaceSession?: {
      sleepingAgentSessionsByPaneKey?: Record<
        string,
        { providerSession?: { id?: unknown }; launchConfig?: Record<string, unknown> }
      >
    }
  }
  const record = Object.values(data.workspaceSession?.sleepingAgentSessionsByPaneKey ?? {}).find(
    (candidate) => candidate.providerSession?.id === PROVIDER_SESSION_ID
  )
  if (!record) {
    throw new Error('Expected a persisted resumable agent session')
  }
  // Why echo: a real provider would need install and auth; the command text is the evidence of a wake.
  record.launchConfig = { agentCommand: 'echo', agentArgs: '', agentEnv: {} }
  writeFileSync(dataPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
}

function readDaemonPid(userDataDir: string): number {
  const raw = readFileSync(
    path.join(userDataDir, 'daemon', `daemon-v${PROTOCOL_VERSION}.pid`),
    'utf8'
  )
  const parsed = JSON.parse(raw) as { pid?: unknown }
  if (typeof parsed.pid !== 'number') {
    throw new Error(`Daemon pid file did not contain a numeric pid: ${raw}`)
  }
  return parsed.pid
}

async function mainSessionIds(page: Page): Promise<string[]> {
  return page.evaluate(async () =>
    (await window.api.pty.listSessions()).map((session) => session.id).sort()
  )
}

/** A baseline read while the host is still registering sessions is not a baseline. */
async function quiescedBaseline(page: Page): Promise<string[]> {
  let previous = await mainSessionIds(page)
  let stable = 0
  for (let attempt = 0; attempt < 40 && stable < 3; attempt++) {
    await page.waitForTimeout(250)
    const current = await mainSessionIds(page)
    stable = JSON.stringify(current) === JSON.stringify(previous) ? stable + 1 : 0
    previous = current
  }
  expect(stable, 'main session list never quiesced before the baseline').toBeGreaterThanOrEqual(3)
  return previous
}

test.describe.configure({ mode: 'serial' })
test.setTimeout(240_000)

test('Resume Center open restores a slept workspace without starting any process', async (// oxlint-disable-next-line no-empty-pattern -- Playwright's second fixture arg is testInfo; the first must be an object destructure to opt out of the default fixture set.
{}, testInfo) => {
  const repoPath = readFileSync(TEST_REPO_PATH_FILE, 'utf-8').trim()
  if (!repoPath || !existsSync(repoPath)) {
    test.skip(true, 'Global setup did not produce a seeded test repo')
    return
  }
  test.skip(process.platform === 'win32', 'Uses POSIX SIGKILL to simulate daemon death')

  const session = createRestartSession(testInfo)
  let firstApp: ElectronApplication | null = null
  let secondApp: ElectronApplication | null = null

  try {
    const first = await session.launch()
    firstApp = first.app
    const page = first.page
    const homeWorktreeId = await attachRepoAndOpenTerminal(page, repoPath)
    await waitForSessionReady(page)
    await waitForActiveWorktree(page)
    await ensureTerminalVisible(page)
    await waitForActiveTerminalManager(page, 30_000)

    const targetWorktreeId = await switchToOtherWorktree(page, homeWorktreeId)
    expect(targetWorktreeId, 'global setup left no second worktree to restore').toBeTruthy()
    const target = targetWorktreeId as string
    await expect
      .poll(async () => page.evaluate(() => window.__store?.getState().activeWorktreeId))
      .toBe(target)
    await ensureTerminalVisible(page)
    await waitForActiveTerminalManager(page, 30_000)
    await waitForPaneCount(page, 1, 30_000)

    const descriptor = await waitForActivePaneHookDescriptor(page)
    const ptyId = await waitForActivePanePtyId(page)
    const transcriptPath = session.seedCodexResumeRollout(PROVIDER_SESSION_ID, repoPath)
    const marker = `RESTORE_NO_WAKE_${Date.now()}`
    await execInTerminal(page, ptyId, `echo ${marker}`)
    await waitForTerminalOutput(page, marker)
    await page.evaluate(
      ({ paneKey, worktreeId, providerSessionId, transcriptPath }) => {
        window.__store?.getState().setAgentStatus(
          paneKey,
          { state: 'working', prompt: 'finish the task', agentType: 'codex' },
          'Codex',
          undefined,
          { worktreeId },
          { providerSession: { key: 'session_id', id: providerSessionId, transcriptPath } }
        )
      },
      {
        paneKey: descriptor.paneKey,
        worktreeId: descriptor.worktreeId,
        providerSessionId: PROVIDER_SESSION_ID,
        transcriptPath
      }
    )

    // The relaunch must land elsewhere, so startup never mounts the subject on its own.
    await switchToWorktree(page, homeWorktreeId)
    await expect
      .poll(async () => page.evaluate(() => window.__store?.getState().activeWorktreeId))
      .toBe(homeWorktreeId)

    const daemonPid = readDaemonPid(session.userDataDir)
    await session.close(firstApp)
    firstApp = null
    stubPersistedResumeCommand(session.userDataDir)
    process.kill(daemonPid, 'SIGKILL')

    const second = await session.launch()
    secondApp = second.app
    const relaunched = second.page
    await waitForSessionReady(relaunched)
    await expect
      .poll(async () => relaunched.evaluate(() => window.__store?.getState().activeWorktreeId), {
        timeout: 15_000
      })
      .toBe(homeWorktreeId)
    await ensureTerminalVisible(relaunched)
    await waitForActiveTerminalManager(relaunched, 30_000)
    const targetTabIds = await relaunched.evaluate(
      (wt) => (window.__store?.getState().tabsByWorktree[wt] ?? []).map((tab) => tab.id),
      target
    )
    expect(targetTabIds.length, 'the slept workspace kept no rows across the restart').toBe(1)

    await relaunched.locator('[data-workspace-activity="agent-workspace"]').first().click()
    await relaunched.getByTestId('workspace-open-resume-center').click()
    const section = relaunched.locator(
      `[data-testid="resume-center-workspace"][data-workspace-key="${target}"]`
    )
    await expect(section).toBeVisible({ timeout: 30_000 })
    await expect(
      relaunched.locator(`[data-testid="resume-center-tab-row"][data-tab-id="${targetTabIds[0]}"]`)
    ).toHaveAttribute('data-residency', 'no-process', { timeout: 30_000 })

    const readTarget = () =>
      relaunched.evaluate((wt) => {
        const s = window.__store!.getState()
        const tabs = s.tabsByWorktree[wt] ?? []
        return {
          tabIds: tabs.map((tab) => tab.id),
          rememberedPtyIds: tabs.map((tab) => tab.ptyId ?? null),
          boundPtys: tabs.flatMap((tab) => s.ptyIdsByTabId[tab.id] ?? []),
          dormancy: tabs.map((tab) => tab.dormancy?.reason ?? null)
        }
      }, target)

    const baseline = await quiescedBaseline(relaunched)
    await section.locator('header [data-slot="button"]').first().click()
    // Evidence for a red run: whether the restore marked the rows before anything could mount them.
    const afterClick = await readTarget()

    // The layout came back: the workspace is active and its row is still there.
    await expect
      .poll(async () => relaunched.evaluate(() => window.__store?.getState().activeWorktreeId), {
        timeout: 15_000
      })
      .toBe(target)

    // Nothing started: sample the host through a window long enough for a mount to spawn and type.
    const known = new Set(baseline)
    const strays: string[] = []
    const deadline = Date.now() + OBSERVE_AFTER_OPEN_MS
    while (Date.now() < deadline) {
      for (const id of await mainSessionIds(relaunched)) {
        if (!known.has(id) && !strays.includes(id)) {
          strays.push(id)
        }
      }
      await relaunched.waitForTimeout(250)
    }
    const state = await readTarget()
    expect(
      strays,
      `opening the workspace from the Resume Center started host sessions; after click ${JSON.stringify(afterClick)}, after window ${JSON.stringify(state)}`
    ).toEqual([])

    expect(state.tabIds, 'the restore dropped or duplicated rows').toEqual(targetTabIds)
    // Not ptyIdsByTabId: hydration refills it with the remembered id, so it cannot witness a spawn.
    expect(state.dormancy).toEqual(['layout-restore'])
    await expect(relaunched.getByTestId('dormant-terminal-open')).toBeVisible({ timeout: 15_000 })
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
