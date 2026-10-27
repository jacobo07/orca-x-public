import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { execInTerminal, waitForActiveTerminalManager } from './helpers/terminal'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { readHookEndpoint } from './helpers/agent-hook-endpoint'

// The Owner's state: an agent in a cmd.exe pane exited to the shell, and nothing offered to bring
// it back. Before cmd.exe reported its prompt, the exit was never marked there at all. This drives
// the real app: a real cmd.exe PTY, the tab-level Resume beside the agent logo, a real respawn over
// cmd's stdin, and a real exit that must bring Resume back. The provider is a test-owned script
// that records its argv, so the exact session id is observed, not assumed.

type Probe = {
  block: string | null
  ptyIds: string[]
  foreground: unknown
  button: string | null
  stripCapability: string | null
  tabButtons: number
  stripTabs: number
  railRows: number
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
      `process.stdin.on('data', (d) => { if (d.includes('CMD_EXIT')) process.exit(0) })`,
      `setTimeout(() => process.exit(0), 120000)`
    ].join('\n')
  )
  return { command: `node ${script}`, argvFile }
}

function launches(argvFile: string): string[] {
  return existsSync(argvFile) ? readFileSync(argvFile, 'utf8').trim().split('\n') : []
}

async function openCmdTab(page: Page, worktreeId: string): Promise<{ tabId: string; paneKey: string }> {
  const tabId = await page.evaluate((wt) => {
    const store = window.__store!
    const created = store.getState().createTab(wt, undefined, 'cmd.exe') as
      | string
      | { id: string }
      | undefined
    const id = typeof created === 'string' ? created : created?.id
    if (!id) {
      throw new Error('ORCA-E2E-PRECONDITION-FAILED [create-tab] cmd.exe')
    }
    store.getState().activateTab(id, { worktreeId: wt })
    store.getState().setActiveTab(id)
    return id
  }, worktreeId)
  await ensureTerminalVisible(page)
  await waitForActiveTerminalManager(page, 30_000)
  const paneKey = await page.evaluate(async (id) => {
    const store = window.__store!
    const started = Date.now()
    while (Date.now() - started < 30_000) {
      const state = store.getState()
      const leaf = state.terminalLayoutsByTabId[id]?.activeLeafId
      if (leaf && (state.ptyIdsByTabId[id] ?? [])[0]) {
        return `${id}:${leaf}`
      }
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    throw new Error(`ORCA-E2E-PRECONDITION-FAILED [pty-start] ${id} never spawned`)
  }, tabId)
  return { tabId, paneKey }
}

async function seed(page: Page, pane: { paneKey: string; worktreeId: string }, id: string, command: string) {
  await page.evaluate(
    ({ pane, id, command }) => {
      const store = window.__store!
      const state = store.getState()
      const now = Date.now()
      store.setState({
        settings: {
          ...state.settings!,
          agentCmdOverrides: { ...state.settings?.agentCmdOverrides, claude: command }
        },
        sleepingAgentSessionsByPaneKey: {
          ...state.sleepingAgentSessionsByPaneKey,
          [pane.paneKey]: {
            paneKey: pane.paneKey,
            tabId: pane.paneKey.split(':')[0],
            worktreeId: pane.worktreeId,
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
    { pane, id, command }
  )
}

function probe(page: Page, paneKey: string): Promise<Probe> {
  return page.evaluate((key) => {
    const state = window.__store!.getState()
    const tabId = key.split(':')[0]
    const button = document.querySelector(
      `[data-testid="tab-session-resume-button"][data-pane-key="${key}"]`
    )
    const strip = document.querySelector(
      `[data-testid="pane-session-resume"][data-pane-key="${key}"]`
    )
    return {
      block: state.sleepingAgentSessionsByPaneKey[key]?.automaticResumeBlockedBy ?? null,
      ptyIds: [...(state.ptyIdsByTabId[tabId] ?? [])],
      foreground: state.paneForegroundAgentByPaneKey[key] ?? null,
      button: button?.getAttribute('data-resume-state') ?? null,
      // Diagnostics only: which surface rendered, and what the pane's own strip concluded.
      stripCapability: strip?.getAttribute('data-capability') ?? null,
      tabButtons: document.querySelectorAll('[data-testid="tab-session-resume-button"]').length,
      stripTabs: document.querySelectorAll('[data-tab-close-button]').length,
      railRows: document.querySelectorAll('[data-terminal-rail-row-kind="tab"]').length
    }
  }, paneKey)
}

async function postSessionStart(
  app: ElectronApplication,
  target: { paneKey: string; worktreeId: string },
  sessionId: string
): Promise<void> {
  const endpoint = await readHookEndpoint(app)
  const response = await fetch(`http://127.0.0.1:${endpoint.port}/hook/claude`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Orca-Agent-Hook-Token': endpoint.token },
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

async function expectButton(page: Page, paneKey: string, state: string | null, message: string) {
  let last: Probe | null = null
  try {
    await expect
      .poll(
        async () => {
          last = await probe(page, paneKey)
          return last.button
        },
        { timeout: 45_000, message }
      )
      .toBe(state)
  } catch (error) {
    throw new Error(`${message}: ${JSON.stringify(last)}\n${String(error)}`)
  }
}

test.describe('Resume beside the agent logo in a cmd.exe tab', () => {
  test.skip(process.platform !== 'win32', 'cmd.exe is the Windows shell under test')

  test('resumes the exact session, and the next exit brings Resume back', async ({
    electronApp,
    orcaPage
  }) => {
    test.setTimeout(240_000)
    const page = orcaPage
    await waitForSessionReady(page)
    const worktreeId = await waitForActiveWorktree(page)
    const { paneKey } = await openCmdTab(page, worktreeId)
    const sessionId = randomUUID()
    const scratch = mkdtempSync(path.join(tmpdir(), 'orca-cmd-resume-'))
    const fake = writeFakeProvider(scratch)
    try {
      await seed(page, { paneKey, worktreeId }, sessionId, fake.command)

      // Enabled by cmd's own tagged prompt; nothing seeds the foreground here.
      await expectButton(page, paneKey, 'one', 'cmd.exe must report its prompt so Resume enables')
      const before = await probe(page, paneKey)
      await page.locator(`[data-testid="tab-session-resume-button"][data-pane-key="${paneKey}"]`).click()

      let newPtyId = ''
      await expect
        .poll(
          async () => {
            const now = await probe(page, paneKey)
            newPtyId = now.ptyIds.find((id) => !before.ptyIds.includes(id)) ?? ''
            return newPtyId !== '' && now.ptyIds.length === 1 ? 'bound' : JSON.stringify(now)
          },
          { timeout: 45_000, message: 'one new PTY in the same pane' }
        )
        .toBe('bound')
      await expect.poll(() => launches(fake.argvFile).length, { timeout: 30_000 }).toBe(1)
      expect(launches(fake.argvFile)[0]).toContain(sessionId)

      await postSessionStart(electronApp, { paneKey, worktreeId }, sessionId)
      await expect.poll(async () => (await probe(page, paneKey)).block, { timeout: 15_000 }).toBeNull()
      await expectButton(page, paneKey, null, 'a live session offers no Resume')

      // The provider exits to cmd. Only cmd's bracketing prompt can say so.
      await execInTerminal(page, newPtyId, 'CMD_EXIT')
      await expect
        .poll(async () => (await probe(page, paneKey)).block, {
          timeout: 30_000,
          message: 'the exit in cmd.exe must be marked'
        })
        .toBe('agent-exited')
      await expectButton(page, paneKey, 'one', 'Resume must come back once cmd is at its prompt')
      expect(launches(fake.argvFile)).toHaveLength(1)
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  })

  test('a tab resumes its own session, never another tab’s', async ({ orcaPage }) => {
    test.setTimeout(240_000)
    const page = orcaPage
    await waitForSessionReady(page)
    const worktreeId = await waitForActiveWorktree(page)
    const first = await openCmdTab(page, worktreeId)
    const second = await openCmdTab(page, worktreeId)
    const scratch = mkdtempSync(path.join(tmpdir(), 'orca-cmd-resume-two-'))
    const fake = writeFakeProvider(scratch)
    const firstSession = randomUUID()
    const secondSession = randomUUID()
    try {
      await seed(page, { paneKey: first.paneKey, worktreeId }, firstSession, fake.command)
      await seed(page, { paneKey: second.paneKey, worktreeId }, secondSession, fake.command)
      await expectButton(page, second.paneKey, 'one', 'the active cmd tab must offer Resume')
      const firstBefore = await probe(page, first.paneKey)

      await page
        .locator(`[data-testid="tab-session-resume-button"][data-pane-key="${second.paneKey}"]`)
        .click()
      await expect.poll(() => launches(fake.argvFile).length, { timeout: 45_000 }).toBe(1)
      expect(launches(fake.argvFile)[0]).toContain(secondSession)
      expect(launches(fake.argvFile)[0]).not.toContain(firstSession)
      const firstAfter = await probe(page, first.paneKey)
      expect(firstAfter.ptyIds).toEqual(firstBefore.ptyIds)
      expect(firstAfter.block).toBe('agent-exited')
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  })
})
