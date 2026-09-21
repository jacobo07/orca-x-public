import { randomUUID } from 'node:crypto'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { test as base, expect } from './helpers/orca-app'
import { waitForActivePaneHookDescriptor, waitForActiveTerminalManager } from './helpers/terminal'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { RuntimeClient } from '../../src/cli/runtime-client'
import type { LiveSessionMaterializationResponse } from '../../src/shared/live-agent-session-presence-types'

// The runtime client (what web and the CLI speak) and the desktop reservation contend for one
// session across the real runtime RPC transport. A stand-in `claude` on PATH keeps any granted
// resume away from a real provider; Claude has no preflight trust step, so no config is written.
const fakeCliDir = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-runtime-ensure-'))
const fakeClaudeSource =
  "process.stdout.write('fake claude ready\\n'); setInterval(() => {}, 60_000)\n"
if (process.platform === 'win32') {
  writeFileSync(path.join(fakeCliDir, 'fake-claude.js'), fakeClaudeSource)
  writeFileSync(
    path.join(fakeCliDir, 'claude.cmd'),
    '@echo off\r\nnode "%~dp0\\fake-claude.js" %*\r\n'
  )
} else {
  const executable = path.join(fakeCliDir, 'claude')
  writeFileSync(executable, `#!/usr/bin/env node\n${fakeClaudeSource}`)
  chmodSync(executable, 0o755)
}

const test = base.extend({
  launchEnv: [{ PATH: `${fakeCliDir}${path.delimiter}${process.env.PATH ?? ''}` }, { option: true }]
})

test.afterAll(() => {
  rmSync(fakeCliDir, { recursive: true, force: true })
})

type Ensured = { terminal: { handle: string }; disposition: string }

function reserve(
  page: Page,
  args: { worktreeId: string; sessionId: string; operationId: string }
): Promise<LiveSessionMaterializationResponse> {
  return page.evaluate(
    ({ worktreeId, sessionId, operationId }) =>
      window.api.agentStatus.reserveMaterialization({
        worktreeId,
        agent: 'claude',
        providerSession: { key: 'session_id', id: sessionId },
        operationId
      }),
    args
  )
}

async function ensureError(call: Promise<unknown>): Promise<string> {
  try {
    await call
    return 'granted'
  } catch (error) {
    return String((error as { code?: unknown }).code ?? (error as Error).message)
  }
}

test('runtime ensure and the desktop reservation contend for one session', async ({
  orcaPage,
  electronApp
}) => {
  test.setTimeout(180_000)
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage, 30_000)
  const { worktreeId } = await waitForActivePaneHookDescriptor(orcaPage)
  const userDataDir = await electronApp.evaluate(({ app }) => app.getPath('userData'))
  const client = new RuntimeClient(userDataDir, 30_000, null, null)
  const S = randomUUID()
  const ensure = () =>
    client.call<Ensured>('terminal.ensureAgentSession', {
      kind: 'explicit',
      worktree: `id:${worktreeId}`,
      agent: 'claude',
      providerSession: { key: 'session_id', id: S }
    })
  const opened: string[] = []

  try {
    // A desktop AI Vault resume is starting S.
    expect(
      (await reserve(orcaPage, { worktreeId, sessionId: S, operationId: 'op-vault' })).outcome
    ).toBe('granted')
    const refused = await ensureError(ensure())
    test.skip(
      refused === 'agent_session_legacy_required',
      'this host routes resumes through the legacy launch (execution owner cannot claim sessions)'
    )
    expect(refused, 'the runtime client must not start a session the desktop is starting').toBe(
      'agent_session_materializing'
    )

    await orcaPage.evaluate(
      (operationId) => window.api.agentStatus.releaseMaterialization({ operationId }),
      'op-vault'
    )
    const granted = await ensure()
    opened.push(granted.result.terminal.handle)
    expect(granted.result.disposition).toBe('created')

    // The runtime's hold is visible to the desktop.
    expect(
      await reserve(orcaPage, { worktreeId, sessionId: S, operationId: 'op-vault-2' })
    ).toMatchObject({
      outcome: 'blocked',
      presence: { kind: 'materializing' }
    })
    // A retry of the same ensure attaches to the runtime it started instead of starting another.
    const retried = await ensure()
    expect(retried.result).toMatchObject({
      disposition: 'adopted',
      terminal: { handle: granted.result.terminal.handle }
    })
  } finally {
    for (const handle of opened) {
      await client.call('terminal.close', { terminal: handle }).catch(() => {})
    }
  }
})
