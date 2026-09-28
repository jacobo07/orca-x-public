import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import {
  sendToTerminal,
  waitForActivePaneHookDescriptor,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForPaneCount
} from './helpers/terminal'
import { ensureTerminalVisible, waitForSessionReady } from './helpers/store'
import { createRestartSession } from './helpers/orca-restart'
import {
  captureRealClaudeIntegrity,
  listClaudeProcesses,
  listTranscripts,
  preflightRealClaude,
  type RealClaudeConfig
} from './helpers/real-claude-provider'

// One-click resume against a REAL, already logged-in Claude Code in an already-trusted,
// test-owned folder, launched from the tab bar, across a full quit and relaunch. Nothing
// seeds a session, a SessionStart, an exit or a prompt state: each comes from the provider,
// its hooks and the shell. Opt-in; see preflightRealClaude for the required environment.

const preflight = preflightRealClaude(process.env)
// cmd.exe marks an agent exit only through its tagged PROMPT; PowerShell through PSReadLine.
const SHELL = process.env.ORCA_E2E_REAL_CLAUDE_SHELL === 'cmd.exe' ? 'cmd.exe' : 'powershell.exe'
const SHELL_PROMPT = SHELL === 'cmd.exe' ? /^[A-Z]:\\[^\n]*>/m : /^PS [A-Z]:\\[^\n]*>/m
const REPLY_MARKER = 'READY34'
const TRUST_OR_LOGIN =
  /trust (this|the files in this) folder|Select login method|Please run \/login|Invalid API key|inside another Claude Code session/i
// Set when the test itself runs from a Claude Code shell; they would reach the provider.
const INHERITED_CLAUDE_ENV = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CONFIG_DIR']

type Probe = {
  capability: string | null
  block: string | null
  sessionId: string | null
  tabPtyIds: string[]
  layoutPtyId: string | null
  domPtyId: string | null
}

function probe(page: Page, paneKey: string): Promise<Probe> {
  return page.evaluate((key) => {
    const state = window.__store!.getState()
    const [tabId, leafId] = key.split(':')
    const record = state.sleepingAgentSessionsByPaneKey[key]
    const banner = document.querySelector(
      `[data-testid="pane-session-resume"][data-pane-key="${key}"]`
    )
    const domPtyId =
      [...document.querySelectorAll<HTMLElement>('[data-pty-id]')].find((el) =>
        (state.ptyIdsByTabId[tabId] ?? []).includes(el.dataset.ptyId ?? '')
      )?.dataset.ptyId ?? null
    return {
      capability: banner?.getAttribute('data-capability') ?? null,
      block: record?.automaticResumeBlockedBy ?? null,
      sessionId: record?.providerSession?.id ?? null,
      tabPtyIds: [...(state.ptyIdsByTabId[tabId] ?? [])],
      layoutPtyId: state.terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId?.[leafId] ?? null,
      domPtyId
    }
  }, paneKey)
}

// Why by tab: a pane's dataset.ptyId can stay unset right after an in-place respawn.
function screen(page: Page, paneKey: string): Promise<string> {
  return page.evaluate((key) => {
    const pane = window.__paneManagers?.get(key.split(':')[0])?.getPanes?.()[0]
    const buffer = pane?.terminal.buffer.active
    const lines: string[] = []
    for (let i = 0; i < (buffer?.length ?? 0); i++) {
      const line = buffer?.getLine(i)
      const text = line?.translateToString(true) ?? ''
      // Why join soft wraps: a long cwd wraps the shell prompt across rows.
      if (line?.isWrapped && lines.length > 0) {
        lines[lines.length - 1] += text
      } else {
        lines.push(text)
      }
    }
    return lines.join('\n')
  }, paneKey)
}

// Why a gate on every screen wait: a trust or login screen must end the run, never be answered.
async function waitForScreen(page: Page, paneKey: string, pattern: RegExp, timeout: number) {
  let text = ''
  let last = 'wait' as 'abort' | 'match' | 'wait'
  // Why a state, not a throw: a throw inside the poll callback is retried, not surfaced.
  const read = async (): Promise<string> => {
    text = await screen(page, paneKey)
    last = TRUST_OR_LOGIN.test(text) ? 'abort' : pattern.test(text) ? 'match' : 'wait'
    return last
  }
  try {
    await expect.poll(read, { timeout, intervals: [500] }).not.toBe('wait')
  } catch (error) {
    // A blank read and a screen without the pattern need different fixes; say which.
    throw new Error(
      `${pattern} not on screen; last read:\n${text.trimEnd().slice(-1500)}\n${error}`
    )
  }
  if (last === 'abort') {
    throw new Error('TRUST_OR_AUTH_PROMPT: aborted without sending any key')
  }
}

// Why two writes: Ink treats one multi-character write as a paste and ignores its Enter.
async function typeLine(page: Page, ptyId: string, text: string): Promise<void> {
  await sendToTerminal(page, ptyId, text)
  await page.waitForTimeout(700)
  await sendToTerminal(page, ptyId, '\r')
}

async function daemonPid(page: Page, ptyId: string): Promise<number | null> {
  const { sessions } = await page.evaluate(() => window.api.pty.management.listSessions())
  return sessions.find((s) => s.sessionId === ptyId && s.isAlive)?.pid ?? null
}

// Live owners only (the read path never consults reservations), asked as an outside pane.
async function presenceKind(
  page: Page,
  args: { worktreeId: string; sessionId: string }
): Promise<string> {
  const reply = await page.evaluate(
    ({ worktreeId, sessionId }) =>
      window.api.agentStatus.readLivePresence({
        worktreeId,
        agent: 'claude',
        providerSession: { key: 'session_id', id: sessionId }
      }),
    args
  )
  return reply.kind
}

// Why reserve, not readLivePresence: only the reserve path consults reservations. Used after
// the new PTY is bound, when main's spawn gate has already admitted the resume.
async function reservationHeld(
  page: Page,
  args: { worktreeId: string; sessionId: string }
): Promise<string> {
  return page.evaluate(async ({ worktreeId, sessionId }) => {
    const operationId = `w34-held-probe-${Date.now()}`
    const reply = await window.api.agentStatus.reserveMaterialization({
      worktreeId,
      agent: 'claude',
      providerSession: { key: 'session_id', id: sessionId },
      operationId
    })
    if (reply.outcome === 'granted') {
      await window.api.agentStatus.releaseMaterialization({ operationId })
      return 'not-held'
    }
    return reply.presence.kind
  }, args)
}

// Once live, an accepted-collision reserve is granted only if no other reservation is held
// (same proof as live-session-materialization-reservation.spec); released at once.
async function reservationReleased(
  page: Page,
  args: { worktreeId: string; sessionId: string }
): Promise<boolean> {
  return page.evaluate(async ({ worktreeId, sessionId }) => {
    const request = {
      worktreeId,
      agent: 'claude' as const,
      providerSession: { key: 'session_id', id: sessionId },
      operationId: `w34-release-proof-${Date.now()}`
    }
    const first = await window.api.agentStatus.reserveMaterialization(request)
    const reply =
      first.outcome === 'granted'
        ? first
        : await window.api.agentStatus.reserveMaterialization({
            ...request,
            accept: {
              kind: first.presence.kind,
              ownersRevision: first.presence.ownersRevision
            }
          })
    if (reply.outcome === 'granted') {
      await window.api.agentStatus.releaseMaterialization({ operationId: request.operationId })
    }
    return first.presence.kind === 'live-elsewhere' && reply.outcome === 'granted'
  }, args)
}

async function savedAgentCommand(page: Page, paneKey: string): Promise<string> {
  return page.evaluate(
    (key) =>
      window.__store!.getState().sleepingAgentSessionsByPaneKey[key]?.launchConfig?.agentCommand ??
      '',
    paneKey
  )
}

// Only the provider process gets the real home back (login + hooks); the binary is real.
// Written in the pane shell's own syntax: Orca runs the startup command through that shell.
// Store-only like the stand-in golden, so it must be applied again after every launch.
function realClaudeCommand(config: RealClaudeConfig): string {
  // Auto-update is off so the provider version cannot change mid-run. Plan mode makes the
  // session unable to edit anything even when the user's default is bypass permissions.
  if (SHELL === 'cmd.exe') {
    // No quotes and no space before &&: a quoted command skips /K delivery, and cmd keeps
    // trailing spaces in a set value.
    return `set USERPROFILE=${config.home}&& set HOME=${config.home}&& set DISABLE_AUTOUPDATER=1&& ${config.bin} --permission-mode plan`
  }
  return `$env:USERPROFILE='${config.home}'; $env:HOME='${config.home}'; $env:DISABLE_AUTOUPDATER='1'; & '${config.bin}' --permission-mode plan`
}

async function useRealClaudeHome(page: Page, config: RealClaudeConfig): Promise<void> {
  const command = realClaudeCommand(config)
  await page.evaluate((command) => {
    const store = window.__store!
    const settings = store.getState().settings!
    store.setState({
      settings: {
        ...settings,
        agentCmdOverrides: { ...settings.agentCmdOverrides, claude: command },
        // The seeded profile's yolo default would append --dangerously-skip-permissions.
        agentDefaultArgs: { ...settings.agentDefaultArgs, claude: '' }
      }
    })
  }, command)
}

async function exitProvider(page: Page, paneKey: string, ptyId: string, sessionId: string) {
  await typeLine(page, ptyId, '/exit')
  await expect
    .poll(async () => (await probe(page, paneKey)).block, { timeout: 60_000 })
    .toBe('agent-exited')
  const after = await probe(page, paneKey)
  expect(after.sessionId, 'the exited record keeps the exact session').toBe(sessionId)
  expect(after.tabPtyIds, 'the shell survives the provider').toEqual([ptyId])
  await expect
    .poll(
      async () =>
        (await page.evaluate((id) => window.api.pty.inspectProcess(id), ptyId)).promptState,
      {
        timeout: 30_000
      }
    )
    .toBe('prompt')
  // The shell under test is the one that reported the exit, not a default that won instead.
  await waitForScreen(page, paneKey, SHELL_PROMPT, 30_000)
  await expect
    .poll(async () => (await probe(page, paneKey)).capability, { timeout: 30_000 })
    .toBe('available')
}

async function resumeOnce(args: {
  page: Page
  config: RealClaudeConfig
  paneKey: string
  worktreeId: string
  sessionId: string
  transcripts: string[]
}): Promise<string> {
  const { page, config, paneKey, worktreeId, sessionId } = args
  const before = await probe(page, paneKey)
  const oldPtyId = before.tabPtyIds[0]
  const oldPid = await daemonPid(page, oldPtyId)
  expect(oldPid, 'the exited shell is a live daemon session').toBeTruthy()
  const priorClaude = new Set(listClaudeProcesses(config.bin).map((p) => p.pid))

  await page
    .locator(`[data-testid="pane-session-resume"][data-pane-key="${paneKey}"]`)
    .locator('[data-testid="pane-session-resume-button"]')
    .click()

  let newPtyId = ''
  await expect
    .poll(
      async () => {
        const now = await probe(page, paneKey)
        newPtyId =
          now.tabPtyIds.length === 1 && now.tabPtyIds[0] !== oldPtyId ? now.tabPtyIds[0] : ''
        return newPtyId !== '' && now.layoutPtyId === newPtyId && now.domPtyId === newPtyId
      },
      { timeout: 90_000, intervals: [100], message: 'tab, layout and pane bind one new PTY' }
    )
    .toBe(true)
  const presence = { worktreeId, sessionId }
  const blockAtBind = (await probe(page, paneKey)).block
  const kindAtBind = await reservationHeld(page, presence)
  console.log(`[w34] at bind: block=${blockAtBind} presence=${kindAtBind}`)
  if (blockAtBind === 'agent-exited') {
    // Not reported live yet: the click's reservation is what makes it visible to others.
    expect(['materializing', 'live-elsewhere']).toContain(kindAtBind)
  }

  await expect.poll(() => daemonPid(page, oldPtyId), { timeout: 20_000 }).toBeNull()
  expect(() => process.kill(oldPid!, 0), 'the old shell process is gone').toThrow()

  await expect
    .poll(
      () =>
        listClaudeProcesses(config.bin).filter(
          (p) => !priorClaude.has(p.pid) && p.commandLine.includes(`--resume ${sessionId}`)
        ).length,
      { timeout: 60_000, message: 'the real claude binary is asked for the exact session' }
    )
    .toBeGreaterThan(0)

  // Only the provider's own SessionStart may lift the exit, and it must name the same session.
  await expect.poll(async () => (await probe(page, paneKey)).block, { timeout: 120_000 }).toBeNull()
  expect((await probe(page, paneKey)).sessionId, 'exact session identity').toBe(sessionId)
  await expect
    .poll(() => presenceKind(page, presence), {
      timeout: 15_000,
      message: 'the reservation hands off to the live owner'
    })
    .toBe('live-elsewhere')
  expect(await reservationReleased(page, { worktreeId, sessionId }), 'no reservation lingers').toBe(
    true
  )
  await expect(
    page.locator(`[data-testid="pane-session-resume"][data-pane-key="${paneKey}"]`)
  ).toHaveCount(0)
  expect(listTranscripts(config), 'no second conversation was created').toEqual(args.transcripts)
  return newPtyId
}

test.describe.configure({ mode: 'serial' })

test('real Claude: exit, full relaunch, one-click resume of the exact session, twice', async (// oxlint-disable-next-line no-empty-pattern -- Playwright's second fixture arg is testInfo.
{}, testInfo) => {
  test.skip(!preflight.ready, preflight.ready ? '' : preflight.reason)
  if (!preflight.ready) {
    return
  }
  test.setTimeout(900_000)
  const { config, version } = preflight
  console.log(`[w34] provider ${version}`)
  const integrityBefore = captureRealClaudeIntegrity(config)
  const transcriptsBefore = listTranscripts(config)
  const claudeBefore = new Set(listClaudeProcesses(config.bin).map((p) => p.pid))
  for (const key of INHERITED_CLAUDE_ENV) {
    delete process.env[key]
  }
  // Why: with the bare isolated home, Windows PowerShell writes its module cache into the
  // pane's working directory, which here is the fixture under integrity check.
  const cacheDir = mkdtempSync(path.join(tmpdir(), 'orca-w34-psmodule-'))
  const session = createRestartSession(testInfo, {
    PSModuleAnalysisCachePath: path.join(cacheDir, 'ModuleAnalysisCache')
  })
  let app: ElectronApplication | null = null
  try {
    let launched = await session.launch()
    app = launched.app
    let page = launched.page
    await waitForSessionReady(page)
    const worktreeId = await page.evaluate(async (folder) => {
      const result = await window.api.repos.add({ path: folder, kind: 'folder' })
      if ('error' in result) {
        throw new Error(result.error)
      }
      const store = window.__store!
      await store.getState().fetchRepos()
      await store.getState().fetchWorktrees(result.repo.id)
      const worktree = store.getState().worktreesByRepo[result.repo.id]?.[0]
      store.getState().setActiveWorktree(worktree!.id)
      return worktree!.id
    }, config.fixture)
    // Persisted, not store-only: main resolves the pane shell from its own settings.
    await page.evaluate(
      (shell) => window.__store!.getState().updateSettings({ terminalWindowsShell: shell }),
      SHELL
    )
    await useRealClaudeHome(page, config)

    await page.getByTestId('tab-bar-new-tab').click()
    await page
      .getByRole('menuitem')
      .filter({ hasText: /^Claude/ })
      .first()
      .click()
    await ensureTerminalVisible(page)
    await waitForActiveTerminalManager(page, 60_000)
    const { paneKey } = await waitForActivePaneHookDescriptor(page, 60_000)
    const shellPty = await waitForActivePanePtyId(page, 90_000)
    // Claude's own input box; the PowerShell prompt never starts a line with this glyph.
    await waitForScreen(page, paneKey, /^❯/m, 120_000)
    await waitForScreen(page, paneKey, /plan mode on/i, 30_000)
    await expect
      .poll(async () => (await probe(page, paneKey)).sessionId, { timeout: 60_000 })
      .not.toBeNull()
    const { sessionId } = await probe(page, paneKey)
    // The resume replays the recorded command, so it must be the one carrying the real home.
    expect(await savedAgentCommand(page, paneKey)).toContain(`USERPROFILE=`)
    const prompt = 'Reply with the word READY immediately followed by 34. Use no tools.'
    await typeLine(page, shellPty, prompt)
    // Test input delivery only: Claude can drop an Enter while its own startup hooks finish.
    // Why \s: Claude separates the input glyph from the text with a non-breaking space.
    // The history echo matches too, so a retry may land on an empty box, which is a no-op.
    const unsent = /^❯\s+Reply with the word READY/m
    for (let retry = 0; retry < 3; retry++) {
      await page.waitForTimeout(5_000)
      const text = await screen(page, paneKey)
      if (!unsent.test(text) || text.includes(REPLY_MARKER)) {
        break
      }
      console.log('[w34] prompt line still visible and no reply yet; pressing Enter again')
      await sendToTerminal(page, shellPty, '\r')
    }
    await waitForScreen(page, paneKey, new RegExp(REPLY_MARKER), 180_000)
    const transcripts = listTranscripts(config)
    expect(transcripts.filter((t) => !transcriptsBefore.includes(t))).toEqual([
      `${sessionId}.jsonl`
    ])

    await exitProvider(page, paneKey, shellPty, sessionId!)
    await session.close(app)
    app = null

    launched = await session.launch()
    app = launched.app
    page = launched.page
    await waitForSessionReady(page)
    await ensureTerminalVisible(page)
    await waitForActiveTerminalManager(page, 60_000)
    await waitForPaneCount(page, 1, 60_000)
    const relaunchedAt = Date.now()
    await useRealClaudeHome(page, config)
    // No input of any kind before the action enables.
    await expect
      .poll(async () => (await probe(page, paneKey)).capability, { timeout: 60_000 })
      .toBe('available')
    const restored = await probe(page, paneKey)
    const paneTabActive = await page.evaluate(
      (tabId) => window.__store!.getState().activeTabId === tabId,
      paneKey.split(':')[0]
    )
    console.log(
      `[w34] resume enabled ${Date.now() - relaunchedAt}ms after relaunch; pane tab active=${paneTabActive}`
    )
    expect(restored.sessionId).toBe(sessionId)
    expect(restored.block).toBe('agent-exited')
    expect(await savedAgentCommand(page, paneKey)).toContain(`USERPROFILE=`)
    const inspection = await page.evaluate(
      (id) => window.api.pty.inspectProcess(id),
      restored.tabPtyIds[0]
    )
    expect(inspection.promptState, 'readiness came from a current daemon').toBe('prompt')

    const ctx = { page, config, paneKey, worktreeId, sessionId: sessionId!, transcripts }
    const firstPty = await resumeOnce(ctx)
    await exitProvider(page, paneKey, firstPty, sessionId!)
    const secondPty = await resumeOnce(ctx)
    expect(new Set([restored.tabPtyIds[0], firstPty, secondPty]).size).toBe(3)
    await exitProvider(page, paneKey, secondPty, sessionId!)
  } finally {
    if (app) {
      await session.close(app)
    }
    await session.dispose()
    rmSync(cacheDir, { recursive: true, force: true })
  }
  // Why: Claude rewrites ~/.claude.json on exit; read it only once this run's providers are gone.
  await expect
    .poll(() => listClaudeProcesses(config.bin).filter((p) => !claudeBefore.has(p.pid)).length, {
      timeout: 30_000
    })
    .toBe(0)
  expect(captureRealClaudeIntegrity(config), 'trust, login, hooks and fixture untouched').toEqual(
    integrityBefore
  )
})

// A plain cmd tab has no startup command for Orca to bracket, so its prompt carries only the
// A marker. This asks whether an agent the USER typed there still has its exit marked.
test('real Claude typed into a plain cmd.exe tab: its exit is marked', async (// oxlint-disable-next-line no-empty-pattern -- Playwright's second fixture arg is testInfo.
{}, testInfo) => {
  test.skip(SHELL !== 'cmd.exe', 'only cmd.exe lacks a D on a plain tab')
  test.skip(!preflight.ready, preflight.ready ? '' : preflight.reason)
  if (!preflight.ready) {
    return
  }
  test.setTimeout(300_000)
  const { config } = preflight
  const integrityBefore = captureRealClaudeIntegrity(config)
  const claudeBefore = new Set(listClaudeProcesses(config.bin).map((p) => p.pid))
  for (const key of INHERITED_CLAUDE_ENV) {
    delete process.env[key]
  }
  const session = createRestartSession(testInfo)
  let app: ElectronApplication | null = null
  try {
    const launched = await session.launch()
    app = launched.app
    const page = launched.page
    await waitForSessionReady(page)
    const paneKey = await page.evaluate(
      async ({ folder, shell }) => {
        const result = await window.api.repos.add({ path: folder, kind: 'folder' })
        if ('error' in result) {
          throw new Error(result.error)
        }
        const store = window.__store!
        await store.getState().updateSettings({ terminalWindowsShell: shell })
        await store.getState().fetchRepos()
        await store.getState().fetchWorktrees(result.repo.id)
        const worktreeId = store.getState().worktreesByRepo[result.repo.id]![0]!.id
        store.getState().setActiveWorktree(worktreeId)
        const created = store.getState().createTab(worktreeId, undefined, shell) as
          | string
          | { id: string }
        const tabId = typeof created === 'string' ? created : created.id
        store.getState().activateTab(tabId, { worktreeId })
        store.getState().setActiveTab(tabId)
        const started = Date.now()
        while (Date.now() - started < 60_000) {
          const state = store.getState()
          const leaf = state.terminalLayoutsByTabId[tabId]?.activeLeafId
          if (leaf && (state.ptyIdsByTabId[tabId] ?? [])[0]) {
            return `${tabId}:${leaf}`
          }
          await new Promise((resolve) => setTimeout(resolve, 200))
        }
        throw new Error(`ORCA-E2E-PRECONDITION-FAILED [pty-start] ${tabId} never spawned`)
      },
      { folder: config.fixture, shell: SHELL }
    )
    await ensureTerminalVisible(page)
    await waitForActiveTerminalManager(page, 60_000)
    const ptyId = (await probe(page, paneKey)).tabPtyIds[0]!
    await waitForScreen(page, paneKey, SHELL_PROMPT, 60_000)

    await typeLine(page, ptyId, realClaudeCommand(config))
    await waitForScreen(page, paneKey, /^❯/m, 120_000)
    await expect
      .poll(async () => (await probe(page, paneKey)).sessionId, { timeout: 60_000 })
      .not.toBeNull()
    const { sessionId } = await probe(page, paneKey)

    await typeLine(page, ptyId, '/exit')
    await waitForScreen(page, paneKey, SHELL_PROMPT, 60_000)
    await expect
      .poll(async () => (await probe(page, paneKey)).block, {
        timeout: 60_000,
        message: 'a typed agent exit in a plain cmd tab must be marked'
      })
      .toBe('agent-exited')
    expect((await probe(page, paneKey)).sessionId).toBe(sessionId)
  } finally {
    if (app) {
      await session.close(app)
    }
    await session.dispose()
  }
  await expect
    .poll(() => listClaudeProcesses(config.bin).filter((p) => !claudeBefore.has(p.pid)).length, {
      timeout: 30_000
    })
    .toBe(0)
  expect(captureRealClaudeIntegrity(config), 'trust, login, hooks and fixture untouched').toEqual(
    integrityBefore
  )
})
