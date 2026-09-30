import { describe, expect, it, vi } from 'vitest'
import type { RuntimeCreateAgentSessionRequest } from '../../shared/agent-session-host-authority'
import { OrcaRuntimeService } from './orca-runtime'

function operationId(now = Date.now()): string {
  return `${now}-0123456789abcdef0123456789abcdef`
}

function request(clientOperationId: string): RuntimeCreateAgentSessionRequest {
  return {
    clientOperationId,
    worktree: 'id:worktree-1',
    agent: 'codex',
    prompt: 'do the thing',
    presentation: 'background'
  }
}

function terminal() {
  return {
    handle: 'term_detach',
    tabId: '11111111-1111-4111-8111-111111111111',
    paneKey: '11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222',
    ptyId: 'pty-detach',
    worktreeId: 'worktree-1',
    title: null,
    surface: 'background' as const
  }
}

function createRuntime(
  provider: {
    supportsAgentSessionClaims: () => boolean
    supportsAgentSessionCreateOperations: () => boolean
  },
  ptyController?: unknown
) {
  const runtime = new OrcaRuntimeService(
    {
      getSettings: () => ({
        disabledTuiAgents: [],
        agentCmdOverrides: {},
        agentDefaultArgs: {},
        agentDefaultEnv: {}
      })
    } as never,
    ptyController as never,
    { getLocalProvider: () => provider as never }
  )
  const internal = runtime as unknown as {
    resolveTerminalWorkspaceLaunchScope: ReturnType<typeof vi.fn>
    markLocalWorkspaceTrustedForAgent: ReturnType<typeof vi.fn>
    markRemoteWorkspaceTrustedForAgent: ReturnType<typeof vi.fn>
  }
  internal.resolveTerminalWorkspaceLaunchScope = vi.fn(async () => ({
    id: 'worktree-1',
    path: '/tmp/worktree-1',
    connectionId: null
  }))
  internal.markLocalWorkspaceTrustedForAgent = vi.fn()
  internal.markRemoteWorkspaceTrustedForAgent = vi.fn()
  return runtime
}

function abortedCaller(): never {
  const abort = new AbortController()
  abort.abort()
  // Why: the field no longer exists on the type; an old caller could still pass one at runtime.
  return { clientId: 'device-a', signal: abort.signal } as never
}

describe('agent-session launch: a client disconnect is Detach', () => {
  it('an already-disconnected caller does not stop createAgentSession: the create completes and a same-id retry replays it', async () => {
    const provider = {
      supportsAgentSessionClaims: vi.fn(() => true),
      supportsAgentSessionCreateOperations: vi.fn(() => true)
    }
    const runtime = createRuntime(provider)
    const createTerminal = vi.spyOn(runtime, 'createTerminal').mockResolvedValue(terminal())
    const id = operationId()

    await expect(runtime.createAgentSession(request(id), abortedCaller())).resolves.toMatchObject({
      disposition: 'created'
    })
    expect(createTerminal.mock.calls[0]?.[1]).not.toHaveProperty('signal')
    expect(provider.supportsAgentSessionCreateOperations).toHaveBeenCalledWith(
      expect.objectContaining({ signal: undefined })
    )

    await expect(
      runtime.createAgentSession(request(id), { clientId: 'device-a' })
    ).resolves.toMatchObject({ disposition: 'replayed' })
    expect(createTerminal).toHaveBeenCalledOnce()
  })

  it('an already-disconnected caller does not stop ensureAgentSession', async () => {
    const provider = {
      supportsAgentSessionClaims: vi.fn(() => true),
      supportsAgentSessionCreateOperations: vi.fn(() => true)
    }
    const runtime = createRuntime(provider)
    const createTerminal = vi.spyOn(runtime, 'createTerminal').mockResolvedValue(terminal())

    await runtime.ensureAgentSession(
      {
        kind: 'explicit',
        worktree: 'id:worktree-1',
        agent: 'codex',
        providerSession: { key: 'session_id', id: 'provider-session-1' }
      },
      abortedCaller()
    )

    expect(createTerminal).toHaveBeenCalledOnce()
    expect(createTerminal.mock.calls[0]?.[1]).not.toHaveProperty('signal')
  })

  // Why: characterizes existing truth (a device disconnect never reached kill/spawn), so it is green before the fix.
  it('a device disconnect kills and spawns nothing', () => {
    const ptyController = {
      spawn: vi.fn(),
      write: vi.fn(() => true),
      kill: vi.fn(() => true),
      getForegroundProcess: async () => null
    }
    const runtime = createRuntime(
      {
        supportsAgentSessionClaims: () => true,
        supportsAgentSessionCreateOperations: () => true
      },
      ptyController
    )

    runtime.onClientDisconnected('device-a')

    expect(ptyController.kill).not.toHaveBeenCalled()
    expect(ptyController.spawn).not.toHaveBeenCalled()
  })
})
