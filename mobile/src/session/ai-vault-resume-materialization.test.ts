import { describe, expect, it, vi } from 'vitest'
import type { AiVaultSession } from '../../../src/shared/ai-vault-types'
import { AGENT_SESSION_HOST_AUTHORITY_CAPABILITY } from '../../../src/shared/agent-session-host-authority'
import { AGENT_SESSION_OMP_RESUME_PATH_RUNTIME_CAPABILITY } from '../../../src/shared/protocol-version'
import type { RpcResponse } from '../transport/types'
import {
  materializeMobileAiVaultResume,
  MobileAiVaultResumeRefusedError,
  type MobileAiVaultResumeRequest
} from './ai-vault-resume-materialization'

type Handler = (params: Record<string, unknown>) => RpcResponse | Promise<RpcResponse>

function ok(result: unknown): RpcResponse {
  return { id: 'r', ok: true, result, _meta: { runtimeId: 'host' } } as RpcResponse
}

function fail(code: string): RpcResponse {
  return {
    id: 'r',
    ok: false,
    error: { code, message: `host said ${code}` },
    _meta: { runtimeId: 'host' }
  } as RpcResponse
}

// A host that holds a desktop reservation for every session unless a handler says otherwise.
function fakeHost(overrides: Record<string, Handler> = {}) {
  const handlers: Record<string, Handler> = {
    'status.get': () => ok({ capabilities: [AGENT_SESSION_HOST_AUTHORITY_CAPABILITY] }),
    'terminal.ensureAgentSession': () => fail('agent_session_materializing'),
    'session.tabs.createTerminal': () =>
      ok({ tab: { type: 'terminal', id: 'tab-legacy', terminal: 'term_legacy', title: 'T' } }),
    'terminal.send': () => ok({ send: { accepted: true } }),
    'session.tabs.activate': () => ok({}),
    ...overrides
  }
  const sendRequest = vi.fn(async (method: string, params?: unknown) => {
    const handler = handlers[method]
    if (!handler) {
      throw new Error(`unexpected request ${method}`)
    }
    return await handler((params ?? {}) as Record<string, unknown>)
  })
  const calls = (method: string) => sendRequest.mock.calls.filter(([name]) => name === method)
  return { client: { sendRequest }, calls }
}

function session(overrides: Partial<AiVaultSession> = {}): AiVaultSession {
  return {
    id: 'claude:S',
    executionHostId: 'local',
    agent: 'claude',
    sessionId: 'session-S',
    title: 'Resume me',
    cwd: '/Users/ada/repo',
    branch: 'main',
    model: null,
    filePath: '/Users/ada/.claude/projects/repo/session-S.jsonl',
    codexHome: null,
    createdAt: null,
    updatedAt: null,
    modifiedAt: '2026-09-17T00:00:00.000Z',
    messageCount: 2,
    totalTokens: 10,
    previewMessages: [],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: '',
    subagent: null,
    ...overrides
  }
}

function request(overrides: Partial<MobileAiVaultResumeRequest> = {}): MobileAiVaultResumeRequest {
  return {
    session: session(),
    worktreeId: 'wt-1',
    workspacePath: '/Users/ada/repo',
    hostPlatform: 'darwin',
    hostTerminalWindowsShell: null,
    settings: null,
    clientMutationId: 'mutation-1',
    ...overrides
  }
}

function ensured(disposition: 'created' | 'adopted', handle = 'term_S'): Handler {
  return () =>
    ok({ disposition, terminal: { handle, tabId: 'tab-S', worktreeId: 'wt-1', title: null } })
}

function expectNothingTyped(host: ReturnType<typeof fakeHost>): void {
  expect(host.calls('session.tabs.createTerminal')).toHaveLength(0)
  expect(host.calls('terminal.send')).toHaveLength(0)
}

function expectOneLegacyLaunch(host: ReturnType<typeof fakeHost>): void {
  expect(host.calls('session.tabs.createTerminal')).toHaveLength(1)
  expect(host.calls('terminal.send')).toHaveLength(1)
  expect((host.calls('terminal.send')[0]?.[1] as { text?: string }).text).toContain('session-S')
}

describe('materializeMobileAiVaultResume against a host that is already starting S', () => {
  it('asks the host first and, refused, creates no terminal and types nothing', async () => {
    const host = fakeHost()

    const outcome = materializeMobileAiVaultResume(host.client, request())

    await expect(outcome).rejects.toMatchObject({
      name: 'MobileAiVaultResumeRefusedError',
      reason: 'materializing',
      message: 'This session is already starting in another pane.'
    })
    expect(host.calls('terminal.ensureAgentSession')).toHaveLength(1)
    expectNothingTyped(host)
    expect(host.calls('session.tabs.activate')).toHaveLength(0)
  })

  it.each([
    ['agent_session_live_elsewhere', 'live-elsewhere'],
    ['agent_session_multiple_live_owners', 'multiple-live-owners'],
    ['agent_session_materializing', 'materializing'],
    ['agent_session_presence_unknown', 'unknown']
  ])('keeps %s a refusal and never falls back', async (code, reason) => {
    const host = fakeHost({ 'terminal.ensureAgentSession': () => fail(code) })

    await expect(materializeMobileAiVaultResume(host.client, request())).rejects.toBeInstanceOf(
      MobileAiVaultResumeRefusedError
    )
    await expect(materializeMobileAiVaultResume(host.client, request())).rejects.toMatchObject({
      reason
    })
    expectNothingTyped(host)
  })
})

describe('materializeMobileAiVaultResume on a current host', () => {
  it('sends the exact selected session and opens the tab the host returned', async () => {
    const host = fakeHost({ 'terminal.ensureAgentSession': ensured('created') })

    const outcome = await materializeMobileAiVaultResume(
      host.client,
      request({ session: session({ id: 'claude:row-7', sessionId: 'session-S' }) })
    )

    expect(outcome).toEqual({
      path: 'structured',
      disposition: 'created',
      worktreeId: 'wt-1',
      tabId: 'tab-S',
      terminal: 'term_S'
    })
    expect(host.calls('terminal.ensureAgentSession')[0]?.[1]).toEqual({
      kind: 'explicit',
      worktree: 'id:wt-1',
      agent: 'claude',
      providerSession: { key: 'session_id', id: 'session-S' },
      presentation: 'background'
    })
    expect(host.calls('session.tabs.activate')[0]?.[1]).toEqual({
      worktree: 'id:wt-1',
      tabId: 'tab-S',
      notifyClients: false,
      navigation: 'caller',
      intent: 'user'
    })
    expectNothingTyped(host)
  })

  it('reports an adopted owner and still types nothing', async () => {
    const host = fakeHost({ 'terminal.ensureAgentSession': ensured('adopted') })

    await expect(materializeMobileAiVaultResume(host.client, request())).resolves.toMatchObject({
      path: 'structured',
      disposition: 'adopted',
      terminal: 'term_S'
    })
    expectNothingTyped(host)
  })

  it('does not fail a started session because its tab could not be focused', async () => {
    const host = fakeHost({
      'terminal.ensureAgentSession': ensured('created'),
      'session.tabs.activate': () => {
        throw new Error('activation lost')
      }
    })

    await expect(materializeMobileAiVaultResume(host.client, request())).resolves.toMatchObject({
      path: 'structured'
    })
    expectNothingTyped(host)
  })

  it('sends both taps of a double tap through the host, which owns single-flight', async () => {
    let starts = 0
    const host = fakeHost({
      'terminal.ensureAgentSession': () => ensured(starts++ === 0 ? 'created' : 'adopted')({})
    })

    const [first, second] = await Promise.all([
      materializeMobileAiVaultResume(host.client, request()),
      materializeMobileAiVaultResume(host.client, request())
    ])

    expect([first.path, second.path]).toEqual(['structured', 'structured'])
    expect(first.terminal).toBe(second.terminal)
    expect(host.calls('terminal.ensureAgentSession')).toHaveLength(2)
    expectNothingTyped(host)
  })

  it('never falls back after a lost response, and the retry adopts what started', async () => {
    let attempt = 0
    const host = fakeHost({
      'terminal.ensureAgentSession': () => {
        if (attempt++ === 0) {
          throw new Error('Request timed out: terminal.ensureAgentSession')
        }
        return ensured('adopted')({})
      }
    })

    await expect(materializeMobileAiVaultResume(host.client, request())).rejects.toThrow(
      'Request timed out'
    )
    expectNothingTyped(host)
    await expect(materializeMobileAiVaultResume(host.client, request())).resolves.toMatchObject({
      disposition: 'adopted'
    })
    expectNothingTyped(host)
  })

  it.each(['runtime_error', 'invalid_params', 'agent_session_claim_unavailable'])(
    'treats %s as a failure, not as permission to type the command',
    async (code) => {
      const host = fakeHost({ 'terminal.ensureAgentSession': () => fail(code) })

      await expect(materializeMobileAiVaultResume(host.client, request())).rejects.toThrow(
        `host said ${code}`
      )
      expectNothingTyped(host)
    }
  )

  it('rejects a malformed success instead of guessing a terminal', async () => {
    const host = fakeHost({ 'terminal.ensureAgentSession': () => ok({ disposition: 'created' }) })

    await expect(materializeMobileAiVaultResume(host.client, request())).rejects.toThrow(
      'Resume response was invalid'
    )
    expectNothingTyped(host)
  })

  it('passes the transcript path for OMP when the host advertises it', async () => {
    const host = fakeHost({
      'status.get': () =>
        ok({
          capabilities: [
            AGENT_SESSION_HOST_AUTHORITY_CAPABILITY,
            AGENT_SESSION_OMP_RESUME_PATH_RUNTIME_CAPABILITY
          ]
        }),
      'terminal.ensureAgentSession': ensured('created')
    })

    await materializeMobileAiVaultResume(
      host.client,
      request({
        session: session({
          agent: 'omp',
          filePath: '/Users/ada/.omp/agent/sessions/repo/sess.jsonl'
        })
      })
    )

    expect(host.calls('terminal.ensureAgentSession')[0]?.[1]).toMatchObject({
      agent: 'omp',
      ompResumeFilePath: '/Users/ada/.omp/agent/sessions/repo/sess.jsonl'
    })
  })

  it.each([
    ['an empty cwd', null, '/Users/ada/repo', 'darwin'],
    ['a trailing slash', '/Users/ada/repo/', '/Users/ada/repo', 'darwin'],
    ['a Windows case difference', 'C:\\Users\\Ada\\Repo', 'c:\\users\\ada\\repo', 'win32']
  ] as const)('keeps the structured path for %s', async (_label, cwd, workspacePath, platform) => {
    const host = fakeHost({ 'terminal.ensureAgentSession': ensured('created') })

    await expect(
      materializeMobileAiVaultResume(
        host.client,
        request({ session: session({ cwd: cwd as string }), workspacePath, hostPlatform: platform })
      )
    ).resolves.toMatchObject({ path: 'structured' })
  })
})

describe('materializeMobileAiVaultResume legacy compatibility (unguarded)', () => {
  it.each([
    ['method_not_found', 'an older host'],
    ['agent_session_legacy_required', 'an owner that cannot claim sessions']
  ])('falls back exactly once on %s (%s)', async (code) => {
    const host = fakeHost({ 'terminal.ensureAgentSession': () => fail(code) })

    await expect(materializeMobileAiVaultResume(host.client, request())).resolves.toEqual({
      path: 'legacy',
      legacyReason: 'host-requires-legacy',
      worktreeId: 'wt-1',
      tabId: 'tab-legacy',
      terminal: 'term_legacy'
    })
    expect(host.calls('terminal.ensureAgentSession')).toHaveLength(1)
    expectOneLegacyLaunch(host)
  })

  it.each([
    ['advertises no structured resume', () => ok({ capabilities: [] })],
    ['answers status with an error', () => fail('runtime_error')],
    [
      'loses the status request',
      () => {
        throw new Error('Connection interrupted')
      }
    ]
  ] as const)('decides legacy before sending when the host %s', async (_label, status) => {
    const host = fakeHost({ 'status.get': status })

    await expect(materializeMobileAiVaultResume(host.client, request())).resolves.toMatchObject({
      path: 'legacy',
      legacyReason: 'host-lacks-structured-resume'
    })
    expect(host.calls('terminal.ensureAgentSession')).toHaveLength(0)
    expectOneLegacyLaunch(host)
  })

  it('keeps OMP legacy on a host without the transcript-path capability', async () => {
    const host = fakeHost({ 'terminal.ensureAgentSession': ensured('created') })

    await expect(
      materializeMobileAiVaultResume(
        host.client,
        request({ session: session({ agent: 'omp', filePath: '/x/sess.jsonl' }) })
      )
    ).resolves.toMatchObject({ path: 'legacy', legacyReason: 'host-lacks-structured-resume' })
    expect(host.calls('terminal.ensureAgentSession')).toHaveLength(0)
  })

  it.each([
    ['a Codex session (per-session CODEX_HOME)', { agent: 'codex', codexHome: '/h/.codex' }],
    ['a real-home Codex session', { agent: 'codex', codexHome: null }],
    ['a session started in a subdirectory', { cwd: '/Users/ada/repo/packages/app' }],
    ['a non-resumable agent', { agent: 'hermes' }]
  ] as const)('keeps %s on the typed command', async (_label, overrides) => {
    const host = fakeHost({ 'terminal.ensureAgentSession': ensured('created') })

    await expect(
      materializeMobileAiVaultResume(
        host.client,
        request({ session: session(overrides as Partial<AiVaultSession>) })
      )
    ).resolves.toMatchObject({ path: 'legacy', legacyReason: 'launch-not-reproducible' })
    expect(host.calls('status.get')).toHaveLength(0)
    expect(host.calls('terminal.ensureAgentSession')).toHaveLength(0)
    expect(host.calls('session.tabs.createTerminal')).toHaveLength(1)
  })
})
