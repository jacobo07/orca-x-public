import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { test as base, expect } from './helpers/orca-app'
import { waitForActivePaneHookDescriptor, waitForActiveTerminalManager } from './helpers/terminal'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { RuntimeClient } from '../../src/cli/runtime-client'
import { decodePairingOffer, type PairingOffer } from '../../src/shared/pairing'
import { sendRemoteRuntimeRequest } from '../../src/shared/remote-runtime-client'
import type { AiVaultSession } from '../../src/shared/ai-vault-types'
import type { LiveSessionMaterializationResponse } from '../../src/shared/live-agent-session-presence-types'
import {
  materializeMobileAiVaultResume,
  type MobileAiVaultResumeOutcome
} from '../../mobile/src/session/ai-vault-resume-materialization'

// The mobile AI Vault resume module itself, speaking the mobile E2EE socket as a paired mobile
// device, contends with the desktop reservation for one session. A stand-in `claude` on PATH keeps
// any granted resume away from a real provider; Claude has no preflight trust step.
const fakeCliDir = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-mobile-vault-'))
/** Where the stand-in agent reports the directory it was actually started in. */
const agentCwdReport = path.join(fakeCliDir, 'agent-cwd.log')
const fakeClaudeSource =
  "const report = process.env.ORCA_E2E_AGENT_CWD_REPORT\n" +
  "if (report) { require('node:fs').appendFileSync(report, process.cwd() + '\\n') }\n" +
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
  launchEnv: [
    {
      PATH: `${fakeCliDir}${path.delimiter}${process.env.PATH ?? ''}`,
      ORCA_E2E_AGENT_CWD_REPORT: agentCwdReport
    },
    { option: true }
  ]
})

test.afterAll(() => {
  rmSync(fakeCliDir, { recursive: true, force: true })
})

type MobileClient = {
  sendRequest: (
    method: string,
    params?: unknown,
    options?: { timeoutMs?: number }
  ) => Promise<never>
  sent: string[]
  /** The host's own error codes, so a skip or verdict never rests on the client's reading of them. */
  hostErrors: string[]
}

/** The mobile RpcClient surface over the real mobile E2EE socket (expo-crypto has no Node build). */
function pairedMobileClient(
  pairing: PairingOffer,
  intercept?: (method: string) => unknown | undefined
): MobileClient {
  const sent: string[] = []
  const hostErrors: string[] = []
  return {
    sent,
    hostErrors,
    sendRequest: async (method, params, options) => {
      sent.push(method)
      const injected = intercept?.(method)
      if (injected !== undefined) {
        return injected as never
      }
      const response = await sendRemoteRuntimeRequest(
        pairing,
        method,
        params,
        options?.timeoutMs ?? 30_000
      )
      if (!response.ok) {
        hostErrors.push(`${method}:${response.error.code}`)
      }
      return { _meta: { runtimeId: 'host' }, ...response } as never
    }
  }
}

function reserve(page: Page, worktreeId: string, sessionId: string, operationId: string) {
  return page.evaluate(
    (args) =>
      window.api.agentStatus.reserveMaterialization({
        worktreeId: args.worktreeId,
        agent: 'claude',
        providerSession: { key: 'session_id', id: args.sessionId },
        operationId: args.operationId
      }) as Promise<LiveSessionMaterializationResponse>,
    { worktreeId, sessionId, operationId }
  )
}

function release(page: Page, operationId: string) {
  return page.evaluate(
    (id) => window.api.agentStatus.releaseMaterialization({ operationId: id }),
    operationId
  )
}

function vaultSession(sessionId: string, cwd: string): AiVaultSession {
  return {
    id: `claude:${sessionId}`,
    executionHostId: 'local',
    agent: 'claude',
    sessionId,
    title: 'Mobile resume',
    cwd,
    branch: null,
    model: null,
    filePath: null,
    codexHome: null,
    createdAt: null,
    updatedAt: null,
    modifiedAt: new Date().toISOString(),
    messageCount: 1,
    totalTokens: 0,
    previewMessages: [],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: '',
    subagent: null
  } as AiVaultSession
}

async function outcomeOf(call: Promise<MobileAiVaultResumeOutcome>): Promise<string> {
  try {
    const outcome = await call
    return outcome.path === 'structured'
      ? `structured:${outcome.disposition}`
      : `legacy:${outcome.legacyReason}`
  } catch (error) {
    const reason = (error as { reason?: unknown }).reason
    return reason ? `refused:${String(reason)}` : `error:${(error as Error).message}`
  }
}

test('a mobile AI Vault resume contends with the desktop reservation before anything starts', async ({
  orcaPage,
  electronApp
}) => {
  test.setTimeout(240_000)
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage, 30_000)
  const { worktreeId } = await waitForActivePaneHookDescriptor(orcaPage)
  const userDataDir = await electronApp.evaluate(({ app }) => app.getPath('userData'))
  const host = new RuntimeClient(userDataDir, 30_000, null, null)

  const offer = await orcaPage.evaluate(() =>
    window.api.mobile.getPairingQR({
      address: '127.0.0.1',
      connectionMode: 'local-only',
      rotate: true
    })
  )
  if (!offer.available) {
    throw new Error(`mobile pairing unavailable: ${offer.reason ?? 'unknown'}`)
  }
  const pairing = decodePairingOffer(offer.pairingUrl)
  const mobile = pairedMobileClient(pairing)

  const status = (await mobile.sendRequest('status.get')) as unknown as {
    ok: boolean
    result?: { deviceScope?: string }
  }
  expect(status.ok, 'the paired device must authenticate over the mobile socket').toBe(true)
  // The host decides every request below as a mobile client, not as a runtime or web client.
  expect(status.result?.deviceScope).toBe('mobile')
  const listed = (await mobile.sendRequest('worktree.ps', { limit: 10_000 })) as unknown as {
    result: { worktrees: { worktreeId: string; path: string }[] }
  }
  const workspacePath = listed.result.worktrees.find((w) => w.worktreeId === worktreeId)?.path
  expect(workspacePath, 'the mobile listing names the active worktree').toBeTruthy()

  const handles = async () =>
    new Set(
      (
        await host.call<{ terminals: { handle: string }[] }>('terminal.list', {
          worktree: `id:${worktreeId}`
        })
      ).result.terminals.map((terminal) => terminal.handle)
    )
  const resume = (client: MobileClient, sessionId: string, cwd = workspacePath!) =>
    materializeMobileAiVaultResume(client, {
      session: vaultSession(sessionId, cwd),
      worktreeId,
      workspacePath: workspacePath!,
      hostPlatform: process.platform,
      hostTerminalWindowsShell: null,
      settings: null,
      clientMutationId: `mobile-e2e-${randomUUID()}`
    })

  const S = randomUUID()
  const T = randomUUID()
  const opened: string[] = []
  try {
    // Desktop AI Vault is starting S.
    expect((await reserve(orcaPage, worktreeId, S, 'op-desktop-S')).outcome).toBe('granted')
    const before = await handles()
    const refused = await outcomeOf(resume(mobile, S))
    // Why: keyed on the host's answer, not the client's outcome, so a client that turns a refusal
    // into a fallback fails here instead of skipping.
    test.skip(
      mobile.hostErrors.includes('terminal.ensureAgentSession:agent_session_legacy_required'),
      'this host routes resumes through the legacy launch (execution owner cannot claim sessions)'
    )
    expect(mobile.hostErrors).toEqual(['terminal.ensureAgentSession:agent_session_materializing'])
    expect(refused, 'mobile must not start a session the desktop is starting').toBe(
      'refused:materializing'
    )
    expect(
      [...(await handles())].filter((h) => !before.has(h)),
      'no ghost terminal'
    ).toEqual([])
    expect(mobile.sent).toContain('terminal.ensureAgentSession')
    expect(mobile.sent).not.toContain('session.tabs.createTerminal')
    expect(mobile.sent).not.toContain('terminal.send')

    // Released: mobile starts S through the host, exactly one new terminal.
    await release(orcaPage, 'op-desktop-S')
    const created = await resume(mobile, S)
    expect(created).toMatchObject({ path: 'structured', disposition: 'created' })
    opened.push(created.terminal)
    const afterCreate = [...(await handles())].filter((h) => !before.has(h))
    expect(afterCreate).toEqual([created.terminal])

    // Reverse: the desktop now sees mobile's S as taken.
    expect(await reserve(orcaPage, worktreeId, S, 'op-desktop-S2')).toMatchObject({
      outcome: 'blocked'
    })
    // A second tap / lost-response retry adopts the runtime it started.
    expect(await resume(mobile, S)).toMatchObject({
      path: 'structured',
      disposition: 'adopted',
      terminal: created.terminal
    })
    expect([...(await handles())].filter((h) => !before.has(h))).toEqual([created.terminal])

    // A different session is not blocked by mobile's S.
    expect((await reserve(orcaPage, worktreeId, T, 'op-desktop-T')).outcome).toBe('granted')
    await release(orcaPage, 'op-desktop-T')

    // Compatibility, stated honestly: an old host (no ensure method) gets the typed command, and
    // that leg is NOT guarded — the desktop's hold on U does not stop it.
    const U = randomUUID()
    expect((await reserve(orcaPage, worktreeId, U, 'op-desktop-U')).outcome).toBe('granted')
    const oldHost = pairedMobileClient(pairing, (method) =>
      method === 'terminal.ensureAgentSession'
        ? {
            id: 'x',
            ok: false,
            error: { code: 'method_not_found', message: 'Unknown method' },
            _meta: { runtimeId: 'host' }
          }
        : undefined
    )
    const legacy = await resume(oldHost, U)
    expect(legacy).toMatchObject({ path: 'legacy', legacyReason: 'host-requires-legacy' })
    opened.push(legacy.terminal)
    expect(oldHost.sent.filter((m) => m === 'session.tabs.createTerminal')).toHaveLength(1)
    expect(oldHost.sent.filter((m) => m === 'terminal.send')).toHaveLength(1)
    await release(orcaPage, 'op-desktop-U')

    // A current host's refusal is never a licence for that leg.
    const V = randomUUID()
    expect((await reserve(orcaPage, worktreeId, V, 'op-desktop-V')).outcome).toBe('granted')
    const again = pairedMobileClient(pairing)
    expect(await outcomeOf(resume(again, V))).toBe('refused:materializing')
    expect(again.sent).not.toContain('terminal.send')
    await release(orcaPage, 'op-desktop-V')

    // Execution-context fidelity: a session recorded in a subdirectory must start THERE. The
    // stand-in reports the directory it actually ran in, so the workspace root cannot pass.
    const W = randomUUID()
    const subdirectory = path.join(workspacePath!, 'packages', 'app')
    mkdirSync(subdirectory, { recursive: true })
    const contextClient = pairedMobileClient(pairing)
    const contextResume = await resume(contextClient, W, subdirectory)
    expect(contextResume).toMatchObject({ path: 'structured' })
    opened.push(contextResume.terminal)
    expect(contextClient.sent).not.toContain('terminal.send')
    await expect
      .poll(
        () => (existsSync(agentCwdReport) ? readFileSync(agentCwdReport, 'utf8').toLowerCase() : ''),
        { timeout: 60_000, message: 'the resumed agent never reported a working directory' }
      )
      .toContain(subdirectory.toLowerCase())
  } finally {
    for (const handle of opened) {
      await host.call('terminal.close', { terminal: handle }).catch(() => {})
    }
  }
})
