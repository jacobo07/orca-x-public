import { describe, expect, it, vi } from 'vitest'
import type { AiVaultSession } from '../../../src/shared/ai-vault-types'
import { AGENT_SESSION_HOST_AUTHORITY_CAPABILITY } from '../../../src/shared/agent-session-host-authority'
import type { RpcResponse } from '../transport/types'
import {
  materializeMobileAiVaultResume,
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

describe('materializeMobileAiVaultResume against a host that is already starting S', () => {
  it('CHARACTERIZATION (today): creates a plain terminal and types the resume command, never asking the host', async () => {
    const host = fakeHost()

    await materializeMobileAiVaultResume(host.client, request())

    expect(host.calls('terminal.ensureAgentSession')).toHaveLength(0)
    expect(host.calls('session.tabs.createTerminal')).toHaveLength(1)
    expect(host.calls('terminal.send')).toHaveLength(1)
    expect((host.calls('terminal.send')[0]?.[1] as { text?: string }).text).toContain('session-S')
  })
})
