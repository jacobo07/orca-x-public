import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import {
  waitForActivePaneHookDescriptor,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
} from './helpers/terminal'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { readHookEndpoint } from './helpers/agent-hook-endpoint'

// Drives the real per-pane "Resume this session" action: the real collision check and spawn gate
// in main, a real PTY respawn, and a real SessionStart through the hook server. The provider is
// a test-owned script that records its argv, so the exact session id is observed, not assumed.

type SeededPane = { paneKey: string; tabId: string; worktreeId: string }

async function seedExitedSession(
  page: Page,
  pane: SeededPane,
  sessionId: string,
  fakeCommand: string
) {
  await page.evaluate(
    ({ pane, sessionId, fakeCommand }) => {
      const store = window.__store!
      const state = store.getState()
      store.setState({
        settings: {
          ...state.settings,
          agentCmdOverrides: { ...state.settings?.agentCmdOverrides, claude: fakeCommand }
        },
        sleepingAgentSessionsByPaneKey: {
          ...state.sleepingAgentSessionsByPaneKey,
          [pane.paneKey]: {
            paneKey: pane.paneKey,
            tabId: pane.tabId,
            worktreeId: pane.worktreeId,
            agent: 'claude',
            providerSession: { key: 'session_id', id: sessionId },
            prompt: '',
            state: 'working',
            capturedAt: Date.now(),
            updatedAt: Date.now(),
            origin: 'live',
            automaticResumeBlockedBy: 'agent-exited'
          }
        },
        paneForegroundAgentByPaneKey: {
          ...state.paneForegroundAgentByPaneKey,
          [pane.paneKey]: { agent: null, shellForeground: true }
        }
      })
    },
    { pane, sessionId, fakeCommand }
  )
}

// Why the store: an in-place respawn can leave the pane container's dataset stale.
function readTabPtyIds(page: Page, tabId: string): Promise<string[]> {
  return page.evaluate((id) => {
    const store = window.__store!
    return [...(store.getState().ptyIdsByTabId[id] ?? [])]
  }, tabId)
}

function readBlock(page: Page, paneKey: string): Promise<string | null> {
  return page.evaluate((key) => {
    const store = window.__store!
    return store.getState().sleepingAgentSessionsByPaneKey[key]?.automaticResumeBlockedBy ?? null
  }, paneKey)
}

test.describe('per-pane Resume this session', () => {
  // Control: the in-place respawn the resume reuses must work on its own.
  test('control: the Codex account restart respawns the same pane', async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    const oldPtyId = await waitForActivePanePtyId(orcaPage)
    const controlTabId = (await waitForActivePaneHookDescriptor(orcaPage)).paneKey.split(':')[0]

    await orcaPage.evaluate((ptyId) => {
      const store = window.__store!
      store.getState().queueCodexPaneRestarts([ptyId])
    }, oldPtyId)

    await expect
      .poll(
        async () => (await readTabPtyIds(orcaPage, controlTabId)).filter((id) => id !== oldPtyId),
        {
          timeout: 30_000
        }
      )
      .toHaveLength(1)
  })

  test('resumes the exact exited session in place and clears the exit only on a real start', async ({
    electronApp,
    orcaPage
  }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    const { paneKey, worktreeId } = await waitForActivePaneHookDescriptor(orcaPage)
    const tabId = paneKey.split(':')[0]
    const oldPtyId = await waitForActivePanePtyId(orcaPage)
    const sessionId = randomUUID()

    const scratch = mkdtempSync(path.join(tmpdir(), 'orca-pane-resume-'))
    const argvFile = path.join(scratch, 'argv.json')
    const fakeProvider = path.join(scratch, 'fake-claude.js')
    writeFileSync(
      fakeProvider,
      `require('fs').writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));\nsetTimeout(() => process.exit(0), 120000)\n`
    )
    try {
      await seedExitedSession(
        orcaPage,
        { paneKey, tabId, worktreeId },
        sessionId,
        `node ${fakeProvider}`
      )

      const banner = orcaPage.locator(
        `[data-testid="pane-session-resume"][data-pane-key="${paneKey}"]`
      )
      await expect(banner).toHaveAttribute('data-capability', 'available')
      // The session id is recovery material, never chrome.
      await expect(banner).not.toContainText(sessionId)

      await banner.locator('[data-testid="pane-session-resume-button"]').click()

      // A new runtime incarnation in the same pane.
      try {
        await expect
          .poll(
            async () => (await readTabPtyIds(orcaPage, tabId)).filter((id) => id !== oldPtyId),
            {
              timeout: 30_000
            }
          )
          .toHaveLength(1)
      } catch (error) {
        const state = await orcaPage.evaluate((key) => {
          const store = window.__store!.getState()
          return {
            diag: (globalThis as Record<string, unknown>).__ptyConnectDiag,
            tabs: store.tabsByWorktree,
            ptyIdsByTabId: store.ptyIdsByTabId,
            foreground: store.paneForegroundAgentByPaneKey[key],
            record: store.sleepingAgentSessionsByPaneKey[key]
          }
        }, paneKey)
        throw new Error(
          `no new PTY after resume: ${JSON.stringify({ state, argv: existsSync(argvFile) })}\n${String(error)}`
        )
      }
      // The provider received exactly the retained session.
      await expect
        .poll(() => (existsSync(argvFile) ? readFileSync(argvFile, 'utf8') : ''), {
          timeout: 30_000,
          message: 'the fake provider should have been launched'
        })
        .toContain(sessionId)
      // Launching is not starting: the exit stays until the provider reports.
      expect(await readBlock(orcaPage, paneKey)).toBe('agent-exited')
      await expect(banner.locator('[data-testid="pane-session-resume-button"]')).toBeDisabled()

      const endpoint = await readHookEndpoint(electronApp)
      const response = await fetch(`http://127.0.0.1:${endpoint.port}/hook/claude`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Orca-Agent-Hook-Token': endpoint.token
        },
        body: JSON.stringify({
          paneKey,
          tabId,
          worktreeId,
          env: endpoint.env,
          version: endpoint.version,
          payload: { hook_event_name: 'SessionStart', session_id: sessionId, source: 'resume' }
        })
      })
      expect(response.status).toBe(204)

      await expect.poll(() => readBlock(orcaPage, paneKey), { timeout: 15_000 }).toBeNull()
      await expect(banner).toHaveCount(0)
      // Main now sees the session live in this pane, so another attempt is not granted.
      const other = await orcaPage.evaluate(
        (args) =>
          window.api.agentStatus.reserveMaterialization({
            worktreeId: args.worktreeId,
            agent: 'claude',
            providerSession: { key: 'session_id', id: args.sessionId },
            operationId: 'op-other'
          }),
        { worktreeId, sessionId }
      )
      expect(other.outcome).toBe('blocked')
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  })
})
