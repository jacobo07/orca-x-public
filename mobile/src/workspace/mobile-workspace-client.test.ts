import { describe, expect, it } from 'vitest'
import type { RpcResponse } from '../transport/types'
import {
  MOBILE_CONVERSATIONS_CAPABILITY,
  describeMobileTurnOutcome,
  latestThreadForAgent,
  loadMobileWorkspace,
  sendMobileAgentMessage,
  type WorkspaceRpcClient
} from './mobile-workspace-client'

const META = { runtimeId: 'host' }

function ok(result: unknown): RpcResponse {
  return { id: '1', ok: true, result, _meta: META }
}
function fail(code: string, message = code): RpcResponse {
  return { id: '1', ok: false, error: { code, message }, _meta: META }
}

function client(
  answers: Record<string, RpcResponse>
): WorkspaceRpcClient & { sent: string[]; params: unknown[] } {
  const sent: string[] = []
  const params: unknown[] = []
  return {
    sent,
    params,
    sendRequest: async (method, payload) => {
      sent.push(method)
      params.push(payload)
      const answer = answers[method]
      if (!answer) {
        throw new Error(`unexpected ${method}`)
      }
      return answer
    }
  }
}

const WORKSPACE = { agents: [{ agent: { id: 'agent_a' } }], threads: [] }

describe('loadMobileWorkspace', () => {
  it('reads the host-projected roster when the host advertises the Workspace', async () => {
    const c = client({
      'status.get': ok({ capabilities: [MOBILE_CONVERSATIONS_CAPABILITY] }),
      'conversations.workspace': ok(WORKSPACE)
    })
    expect(await loadMobileWorkspace(c)).toEqual({ kind: 'ready', ...WORKSPACE })
  })

  it('fails closed against an older host: no capability means unsupported, and nothing is called', async () => {
    const c = client({ 'status.get': ok({ capabilities: ['aiVault.v1'] }) })
    expect(await loadMobileWorkspace(c)).toEqual({ kind: 'unsupported' })
    expect(c.sent).toEqual(['status.get'])
  })

  it('reads a refusal from a host that lacks the method as unsupported, never as "no agents"', async () => {
    for (const code of ['forbidden', 'method_not_found', 'capability_unsupported']) {
      const c = client({
        'status.get': ok({ capabilities: [MOBILE_CONVERSATIONS_CAPABILITY] }),
        'conversations.workspace': fail(code)
      })
      expect(await loadMobileWorkspace(c), code).toEqual({ kind: 'unsupported' })
    }
  })

  it('keeps a real failure a failure (control): a runtime error is not "unsupported"', async () => {
    const c = client({
      'status.get': ok({ capabilities: [MOBILE_CONVERSATIONS_CAPABILITY] }),
      'conversations.workspace': fail('runtime_error', 'disk unreadable')
    })
    expect(await loadMobileWorkspace(c)).toEqual({ kind: 'error', message: 'disk unreadable' })
  })
})

describe('sendMobileAgentMessage', () => {
  it('makes the thread real on the first message, then sends the turn with no cwd', async () => {
    const c = client({
      'conversations.createForAgent': ok({ outcome: 'created', record: { id: 'conv_9' } }),
      'conversations.sendTurn': ok({
        outcome: 'auth-required',
        detail: 'codex credential is no-credential'
      })
    })
    const result = await sendMobileAgentMessage(c, {
      agentId: 'agent_a',
      conversationId: null,
      text: 'hi'
    })

    expect(result).toEqual({
      kind: 'sent',
      conversationId: 'conv_9',
      outcome: 'auth-required',
      detail: 'codex credential is no-credential'
    })
    expect(c.sent).toEqual(['conversations.createForAgent', 'conversations.sendTurn'])
    expect(c.params[1]).toEqual({ id: 'conv_9', text: 'hi' })
  })

  it('continues an existing thread without creating another', async () => {
    const c = client({ 'conversations.sendTurn': ok({ outcome: 'completed' }) })
    await sendMobileAgentMessage(c, { agentId: 'agent_a', conversationId: 'conv_1', text: 'again' })
    expect(c.sent).toEqual(['conversations.sendTurn'])
  })

  it('reports a refused create in its own words and sends nothing', async () => {
    const c = client({ 'conversations.createForAgent': ok({ outcome: 'agent-missing' }) })
    const result = await sendMobileAgentMessage(c, {
      agentId: 'agent_a',
      conversationId: null,
      text: 'hi'
    })
    expect(result).toEqual({ kind: 'not-created', outcome: 'agent-missing' })
    expect(c.sent).toEqual(['conversations.createForAgent'])
  })
})

describe('latestThreadForAgent', () => {
  it("picks that agent's newest readable thread and ignores everyone else's", () => {
    const threads = [
      {
        outcome: 'ok',
        id: 'conv_old',
        updatedAt: 1,
        agent: { kind: 'agent', agentId: 'agent_a', name: 'A' }
      },
      {
        outcome: 'ok',
        id: 'conv_new',
        updatedAt: 5,
        agent: { kind: 'agent', agentId: 'agent_a', name: 'A' }
      },
      {
        outcome: 'ok',
        id: 'conv_b',
        updatedAt: 9,
        agent: { kind: 'agent', agentId: 'agent_b', name: 'B' }
      },
      { outcome: 'unreadable', id: 'conv_x', reason: 'bad' }
    ] as never
    expect(latestThreadForAgent(threads, 'agent_a')).toBe('conv_new')
    expect(latestThreadForAgent(threads, 'agent_c')).toBeNull()
  })
})

describe('describeMobileTurnOutcome', () => {
  it('uses product words, never a status code', () => {
    const text = describeMobileTurnOutcome('auth-required').text
    expect(text).toMatch(/sign in/i)
    expect(text).not.toMatch(/auth-required|401|runtime_error/)
  })
})
