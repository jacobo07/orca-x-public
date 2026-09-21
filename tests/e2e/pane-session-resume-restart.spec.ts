import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { TEST_REPO_PATH_FILE } from './global-setup'
import {
  execInTerminal,
  waitForActivePaneHookDescriptor,
  waitForActiveTerminalManager,
  waitForPaneCount,
  waitForTerminalOutput
} from './helpers/terminal'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'
import { readHookEndpoint } from './helpers/agent-hook-endpoint'

// Per-pane "Resume this session" across a real quit and relaunch: a fresh Electron process on
// the same profile, a shell the daemon kept, and nothing typed before the action enables. The
// provider is a test-owned script that records its argv and echoes its stdin.

type PaneProbe = {
  capability: string | null
  block: string | null
  sessionId: string | null
  tabPtyIds: string[]
  layoutPtyId: string | null
  domPtyId: string | null
  foregroundAgent: string | null
}

const spawnLogTimes: number[] = []

async function probePane(page: Page, paneKey: string): Promise<PaneProbe> {
  return page.evaluate((key) => {
    const state = window.__store!.getState()
    const [tabId, leafId] = key.split(':')
    const record = state.sleepingAgentSessionsByPaneKey[key]
    const banner = document.querySelector(
      `[data-testid="pane-session-resume"][data-pane-key="${key}"]`
    )
    // The banner portals into the pane container, which carries the PTY binding.
    const pane = banner?.parentElement ?? null
    return {
      capability: banner?.getAttribute('data-capability') ?? null,
      block: record?.automaticResumeBlockedBy ?? null,
      sessionId: record?.providerSession?.id ?? null,
      tabPtyIds: [...(state.ptyIdsByTabId[tabId] ?? [])],
      layoutPtyId: state.terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId?.[leafId] ?? null,
      domPtyId: pane?.dataset.ptyId ?? null,
      foregroundAgent: state.paneForegroundAgentByPaneKey[key]?.agent ?? null
    }
  }, paneKey)
}

async function seedExitedRecord(page: Page, paneKey: string, worktreeId: string, id: string) {
  await page.evaluate(
    ({ paneKey, worktreeId, id }) => {
      const store = window.__store!
      const state = store.getState()
      const now = Date.now()
      store.setState({
        sleepingAgentSessionsByPaneKey: {
          ...state.sleepingAgentSessionsByPaneKey,
          [paneKey]: {
            paneKey,
            tabId: paneKey.split(':')[0],
            worktreeId,
            agent: 'claude',
            providerSession: { key: 'session_id', id },
            prompt: '',
            state: 'working',
            capturedAt: now,
            updatedAt: now,
            origin: 'live',
            automaticResumeBlockedBy: 'agent-exited'
          }
        }
      })
    },
    { paneKey, worktreeId, id }
  )
}

async function useFakeClaude(page: Page, command: string): Promise<void> {
  await page.evaluate((command) => {
    const store = window.__store!
    const state = store.getState()
    store.setState({
      settings: {
        ...state.settings!,
        agentCmdOverrides: { ...state.settings?.agentCmdOverrides, claude: command }
      }
    })
  }, command)
}

async function daemonSession(page: Page, ptyId: string) {
  const { sessions } = await page.evaluate(() => window.api.pty.management.listSessions())
  return sessions.find((session) => session.sessionId === ptyId) ?? null
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function postSessionStart(
  app: ElectronApplication,
  target: { paneKey: string; worktreeId: string },
  sessionId: string
): Promise<void> {
  const endpoint = await readHookEndpoint(app)
  const response = await fetch(`http://127.0.0.1:${endpoint.port}/hook/claude`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Orca-Agent-Hook-Token': endpoint.token
    },
    body: JSON.stringify({
      paneKey: target.paneKey,
      tabId: target.paneKey.split(':')[0],
      worktreeId: target.worktreeId,
      env: endpoint.env,
      version: endpoint.version,
      payload: { hook_event_name: 'SessionStart', session_id: sessionId, source: 'resume' }
    })
  })
  expect(response.status).toBe(204)
}

function writeFakeProvider(scratch: string): { command: string; argvFile: string } {
  const argvFile = path.join(scratch, 'argv.jsonl')
  const script = path.join(scratch, 'fake-claude.js')
  writeFileSync(
    script,
    [
      `const fs = require('fs')`,
      `fs.appendFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)) + '\\n')`,
      `process.stdin.setEncoding('utf8')`,
      `process.stdin.on('data', (d) => {`,
      `  if (d.includes('W33_EXIT')) process.exit(0)`,
      `  process.stdout.write('ECHO<' + d.trim() + '>\\r\\n')`,
      `})`,
      `setTimeout(() => process.exit(0), 120000)`
    ].join('\n')
  )
  return { command: `node ${script}`, argvFile }
}

function launches(argvFile: string): string[] {
  return existsSync(argvFile) ? readFileSync(argvFile, 'utf8').trim().split('\n') : []
}

// Resume and prove every layer moved to the new PTY, the old shell died, and input reaches it.
async function resumeAndVerify(args: {
  app: ElectronApplication
  page: Page
  paneKey: string
  worktreeId: string
  sessionId: string
  argvFile: string
  cycle: number
}): Promise<string> {
  const { page, paneKey, sessionId, argvFile } = args
  const before = await probePane(page, paneKey)
  const oldPtyId = before.tabPtyIds[0]
  const oldSession = await daemonSession(page, oldPtyId)
  expect(oldSession?.pid, 'the old shell is a live daemon session').toBeTruthy()

  // Why the rebind is slow here: a startup-command spawn first waits 12 animation frames for
  // a stable grid, and this headless window renders about one frame a second.
  const clickedAt = Date.now()
  await page
    .locator(`[data-testid="pane-session-resume"][data-pane-key="${paneKey}"]`)
    .locator('[data-testid="pane-session-resume-button"]')
    .click()

  let newPtyId = ''
  const phases: Record<string, number> = {}
  const mark = (name: string): void => {
    phases[name] ??= Date.now() - clickedAt
  }
  const spawnLogsBefore = spawnLogTimes.length
  // Why one predicate: the new id is only known once it appears, so compare inside the poll.
  await expect
    .poll(
      async () => {
        const probe = await probePane(page, paneKey)
        const [only] = probe.tabPtyIds
        newPtyId = only && only !== oldPtyId ? only : ''
        if (probe.foregroundAgent === 'claude') {
          mark('respawn-began')
        }
        if (!probe.tabPtyIds.includes(oldPtyId)) {
          mark('old-unbound')
        }
        if (spawnLogTimes.length > spawnLogsBefore) {
          phases['main-spawn-logged'] ??= spawnLogTimes[spawnLogsBefore] - clickedAt
        }
        if (newPtyId) {
          mark('tab-bound')
        }
        if (newPtyId && probe.layoutPtyId === newPtyId) {
          mark('layout-bound')
        }
        if (newPtyId && probe.domPtyId === newPtyId) {
          mark('dom-bound')
        }
        return newPtyId !== '' &&
          probe.tabPtyIds.length === 1 &&
          probe.layoutPtyId === newPtyId &&
          probe.domPtyId === newPtyId
          ? 'bound'
          : JSON.stringify(probe)
      },
      {
        timeout: 45_000,
        intervals: [100],
        message: 'the tab, layout and pane should all bind one new PTY'
      }
    )
    .toBe('bound')
  console.log(
    `[w33] cycle ${args.cycle}: new PTY bound after ${Date.now() - clickedAt}ms ${JSON.stringify(phases)}`
  )

  await expect.poll(() => launches(argvFile).length, { timeout: 30_000 }).toBe(args.cycle)
  expect(launches(argvFile).at(-1)).toContain(sessionId)
  // Launching is not starting: the exit stays until the provider reports.
  expect((await probePane(page, paneKey)).block).toBe('agent-exited')

  await expect
    .poll(async () => (await daemonSession(page, oldPtyId))?.isAlive ?? false, { timeout: 15_000 })
    .toBe(false)
  await expect.poll(() => isProcessAlive(oldSession!.pid!), { timeout: 15_000 }).toBe(false)

  await postSessionStart(args.app, args, sessionId)
  await expect
    .poll(async () => (await probePane(page, paneKey)).block, { timeout: 15_000 })
    .toBeNull()
  await expect(
    page.locator(`[data-testid="pane-session-resume"][data-pane-key="${paneKey}"]`)
  ).toHaveCount(0)

  const marker = `W33_ROUNDTRIP_${args.cycle}`
  await execInTerminal(page, newPtyId, marker)
  await waitForTerminalOutput(page, `ECHO<${marker}>`, 15_000)
  return newPtyId
}

test.describe.configure({ mode: 'serial' })

test('restart: an exited pane resumes its exact session with no command typed', async (// oxlint-disable-next-line no-empty-pattern -- Playwright's second fixture arg is testInfo.
{}, testInfo) => {
  const repoPath = readFileSync(TEST_REPO_PATH_FILE, 'utf-8').trim()
  test.skip(!repoPath || !existsSync(repoPath), 'Global setup did not produce a seeded test repo')
  const session = createRestartSession(testInfo)
  const scratch = mkdtempSync(path.join(tmpdir(), 'orca-w33-'))
  const fake = writeFakeProvider(scratch)
  let firstApp: ElectronApplication | null = null
  let secondApp: ElectronApplication | null = null
  const sessionId = randomUUID()
  try {
    const first = await session.launch()
    firstApp = first.app
    const worktreeId = await attachRepoAndOpenTerminal(first.page, repoPath)
    await waitForSessionReady(first.page)
    await waitForActiveWorktree(first.page)
    await ensureTerminalVisible(first.page)
    await waitForActiveTerminalManager(first.page, 30_000)
    await waitForPaneCount(first.page, 1, 30_000)
    const { paneKey } = await waitForActivePaneHookDescriptor(first.page)
    await seedExitedRecord(first.page, paneKey, worktreeId, sessionId)
    // A fresh shell, never typed into, earns readiness from its first prompt.
    await expect
      .poll(async () => (await probePane(first.page, paneKey)).capability, { timeout: 30_000 })
      .toBe('available')
    const beforeQuit = await probePane(first.page, paneKey)

    await session.close(firstApp)
    firstApp = null

    const second = await session.launch()
    secondApp = second.app
    const page = second.page
    // Spawn phase timings (ORCA_PTY_SPAWN_TIMING) go to main's stdout.
    second.app.process().stdout?.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n')) {
        if (line.includes('[pty-spawn-timing]')) {
          spawnLogTimes.push(Date.now())
          console.log(`[w33] ${line.trim()}`)
        }
      }
    })
    await waitForSessionReady(page)
    await ensureTerminalVisible(page)
    await waitForActiveTerminalManager(page, 30_000)
    await waitForPaneCount(page, 1, 30_000)
    const relaunchedAt = Date.now()
    // No input is sent here: readiness must come from the restored runtime itself.
    await expect
      .poll(async () => (await probePane(page, paneKey)).capability, {
        timeout: 30_000,
        message: 'Resume should enable after the relaunch without any typed command'
      })
      .toBe('available')
    const restored = await probePane(page, paneKey)
    console.log(
      `[w33] enabled ${Date.now() - relaunchedAt}ms after relaunch; ptys before=${beforeQuit.tabPtyIds} after=${restored.tabPtyIds}`
    )
    expect(restored.sessionId).toBe(sessionId)
    expect(restored.block).toBe('agent-exited')

    await useFakeClaude(page, fake.command)
    const cycleOnePty = await resumeAndVerify({
      app: second.app,
      page,
      paneKey,
      worktreeId,
      sessionId,
      argvFile: fake.argvFile,
      cycle: 1
    })

    // Second cycle: the provider exits back to the shell, the strip returns, and resuming
    // again moves the same pane to a third PTY.
    await execInTerminal(page, cycleOnePty, 'W33_EXIT')
    try {
      await expect
        .poll(async () => (await probePane(page, paneKey)).capability, {
          timeout: 30_000,
          message: 'the exited provider should bring the resume action back'
        })
        .toBe('available')
    } catch (error) {
      const state = await page.evaluate(
        async ({ key, ptyId }) => {
          const s = window.__store!.getState()
          return {
            status: s.agentStatusByPaneKey[key] ?? null,
            foreground: s.paneForegroundAgentByPaneKey[key] ?? null,
            record: s.sleepingAgentSessionsByPaneKey[key] ?? null,
            launch: s.agentLaunchConfigByPaneKey[key] ?? null,
            inspection: await window.api.pty.inspectProcess(ptyId).catch(String)
          }
        },
        { key: paneKey, ptyId: cycleOnePty }
      )
      throw new Error(`exit not detected: ${JSON.stringify(state)}\n${String(error)}`)
    }
    const cycleTwoPty = await resumeAndVerify({
      app: second.app,
      page,
      paneKey,
      worktreeId,
      sessionId,
      argvFile: fake.argvFile,
      cycle: 2
    })
    expect(new Set([...restored.tabPtyIds, cycleOnePty, cycleTwoPty]).size).toBe(3)
  } finally {
    if (secondApp) {
      await session.close(secondApp)
    }
    if (firstApp) {
      await session.close(firstApp)
    }
    await session.dispose()
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('a command running in the shell keeps the resume action from destroying it', async ({
  orcaPage
}) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage, 30_000)
  const { paneKey, worktreeId } = await waitForActivePaneHookDescriptor(orcaPage)
  const scratch = mkdtempSync(path.join(tmpdir(), 'orca-w33-busy-'))
  const fake = writeFakeProvider(scratch)
  try {
    await useFakeClaude(orcaPage, fake.command)
    await seedExitedRecord(orcaPage, paneKey, worktreeId, randomUUID())
    await expect
      .poll(async () => (await probePane(orcaPage, paneKey)).capability, { timeout: 30_000 })
      .toBe('available')
    const { tabPtyIds } = await probePane(orcaPage, paneKey)

    // An in-process cmdlet: no child process, only the shell's own command-start marker.
    await execInTerminal(orcaPage, tabPtyIds[0], 'Start-Sleep -Seconds 40')
    await expect
      .poll(async () => (await probePane(orcaPage, paneKey)).capability, { timeout: 15_000 })
      .not.toBe('available')

    // A stale idle reading (e.g. taken while hidden) must still lose to the click-time check.
    await orcaPage.evaluate((key) => {
      window.__store!.getState().setPaneForegroundAgent(key, {
        agent: null,
        shellForeground: true
      })
    }, paneKey)
    await expect.poll(async () => (await probePane(orcaPage, paneKey)).capability).toBe('available')
    await orcaPage
      .locator(`[data-testid="pane-session-resume"][data-pane-key="${paneKey}"]`)
      .locator('[data-testid="pane-session-resume-button"]')
      .click()
    await expect(orcaPage.getByTestId('pane-session-resume-error')).toBeVisible()
    const after = await probePane(orcaPage, paneKey)
    expect(after.tabPtyIds).toEqual(tabPtyIds)
    expect(after.capability).not.toBe('available')
    expect(launches(fake.argvFile)).toEqual([])
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})
