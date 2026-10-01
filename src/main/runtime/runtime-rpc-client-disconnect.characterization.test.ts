// 2026-09-30, dws Phase 3: cases A and B inverted in place; launch-class RPCs receive no socket signal;
// control D pins that observation still aborts; case E pins that a disconnect-refusing runtime is never
// handed a disconnect. The stubbed-dispatcher socket-close fan-out is pinned in
// runtime-rpc-websocket-long-poll-caps.test.ts; the runtime-layer refusal was removed with the launch guards.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import type WebSocket from 'ws'
import { describe, expect, it } from 'vitest'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { DeviceRegistry } from './device-registry'
import { waitFor } from './runtime-rpc-test-harness'
import { mintConversationId } from '../../shared/conversation-identity'
import type { OrcaRuntimeService } from './orca-runtime'
import type { RuntimeAgentSessionRpcCaller } from '../../shared/agent-session-host-authority'

class FakeWebSocket extends EventEmitter {
  readonly OPEN = 1
  readyState = this.OPEN
}

const VALID_CREATE_AGENT_SESSION_PARAMS = {
  clientOperationId: '1752883200000-0123456789abcdef0123456789abcdef',
  worktree: 'id:worktree-1',
  agent: 'codex',
  presentation: 'focused'
}

function setUpServer(runtime: Partial<OrcaRuntimeService>): {
  server: OrcaRuntimeRpcServer
  ws: FakeWebSocket
  deviceToken: string
} {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-disconnect-'))
  const server = new OrcaRuntimeRpcServer({
    runtime: runtime as unknown as OrcaRuntimeService,
    userDataPath,
    enableWebSocket: false
  })
  server['deviceRegistry'] = new DeviceRegistry(userDataPath)
  const entry = server['deviceRegistry']!.addDevice('runtime-test', 'runtime')
  const ws = new FakeWebSocket()
  server['mobileSocketWiring'] = {
    getConnectionId: () => 'conn-test'
  } as unknown as NonNullable<(typeof server)['mobileSocketWiring']>
  return { server, ws, deviceToken: entry.token }
}

describe('dws characterization (a): a client disconnect never cancels a launch — inverted in Phase 3', () => {
  it('closing the requesting socket does not abort an in-flight terminal.createAgentSession — the create completes', async () => {
    let capturedCaller: RuntimeAgentSessionRpcCaller | undefined
    let resolveGate: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      resolveGate = resolve
    })
    const runtime = {
      getRuntimeId: () => 'runtime-1',
      createAgentSession: async (_params: unknown, caller?: RuntimeAgentSessionRpcCaller) => {
        capturedCaller = caller
        await gate
        return {
          terminal: { handle: 'term_1', worktreeId: 'worktree-1', title: null },
          disposition: 'created' as const
        }
      }
    }
    const { server, ws, deviceToken } = setUpServer(runtime)
    const replies: Record<string, unknown>[] = []

    try {
      const dispatchPromise = server['handleWebSocketMessage'](
        JSON.stringify({
          id: 'req_create',
          method: 'terminal.createAgentSession',
          deviceToken,
          params: VALID_CREATE_AGENT_SESSION_PARAMS
        }),
        (response) => replies.push(JSON.parse(response) as Record<string, unknown>),
        () => {},
        undefined,
        ws as unknown as WebSocket
      )

      await waitFor(() => capturedCaller !== undefined)
      expect(Object.keys(capturedCaller ?? {})).not.toContain('signal')

      ws.readyState = 3
      ws.emit('close')

      expect(Object.keys(capturedCaller ?? {})).not.toContain('signal')

      resolveGate?.()
      await dispatchPromise
      expect(replies).toContainEqual(expect.objectContaining({ id: 'req_create', ok: true }))
    } finally {
      await server.stop()
    }
  })

  it('an open socket hands the launch no abort signal at all', async () => {
    let capturedCaller: RuntimeAgentSessionRpcCaller | undefined
    const runtime = {
      getRuntimeId: () => 'runtime-1',
      createAgentSession: async (_params: unknown, caller?: RuntimeAgentSessionRpcCaller) => {
        capturedCaller = caller
        return {
          terminal: { handle: 'term_1', worktreeId: 'worktree-1', title: null },
          disposition: 'created' as const
        }
      }
    }
    const { server, ws, deviceToken } = setUpServer(runtime)
    const replies: Record<string, unknown>[] = []

    try {
      await server['handleWebSocketMessage'](
        JSON.stringify({
          id: 'req_create_open',
          method: 'terminal.createAgentSession',
          deviceToken,
          params: VALID_CREATE_AGENT_SESSION_PARAMS
        }),
        (response) => replies.push(JSON.parse(response) as Record<string, unknown>),
        () => {},
        undefined,
        ws as unknown as WebSocket
      )

      expect(Object.keys(capturedCaller ?? {})).not.toContain('signal')
      expect(replies).toContainEqual(expect.objectContaining({ id: 'req_create_open', ok: true }))
    } finally {
      await server.stop()
    }
  })

  it('a conversation turn already dispatched is not reached by the disconnect', async () => {
    let capturedArgs: { id: string; text: string } | undefined
    let resolveGate: (() => void) | undefined
    let completedAfterClose = false
    const gate = new Promise<void>((resolve) => {
      resolveGate = resolve
    })
    const conversationId = mintConversationId()
    const runtime = {
      getRuntimeId: () => 'runtime-1',
      getConversationHost: () => ({
        sendTurn: async (args: { id: string; text: string }) => {
          capturedArgs = args
          await gate
          completedAfterClose = true
          return { status: 'accepted' as const }
        }
      })
    }
    const { server, ws, deviceToken } = setUpServer(runtime as unknown as Partial<OrcaRuntimeService>)
    const replies: Record<string, unknown>[] = []

    try {
      const dispatchPromise = server['handleWebSocketMessage'](
        JSON.stringify({
          id: 'req_turn',
          method: 'conversations.sendTurn',
          deviceToken,
          params: { id: conversationId, text: 'hello' }
        }),
        (response) => replies.push(JSON.parse(response) as Record<string, unknown>),
        () => {},
        undefined,
        ws as unknown as WebSocket
      )

      await waitFor(() => capturedArgs !== undefined)
      // Why: no `signal` key travels — sendTurn destructures only { runtime } in the handler.
      expect(Object.keys(capturedArgs ?? {}).sort()).toEqual(['id', 'text'])

      ws.readyState = 3
      ws.emit('close')

      expect(completedAfterClose).toBe(false)
      resolveGate?.()
      await dispatchPromise

      expect(completedAfterClose).toBe(true)
      expect(replies).toContainEqual(expect.objectContaining({ id: 'req_turn', ok: true }))
    } finally {
      await server.stop()
    }
  })

  it('closing the requesting socket still aborts an in-flight terminal.wait — observation keeps its abort', async () => {
    let capturedSignal: AbortSignal | undefined
    let resolveGate: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      resolveGate = resolve
    })
    const runtime = {
      getRuntimeId: () => 'runtime-1',
      waitForTerminal: async (_terminal: string, options: { signal?: AbortSignal }) => {
        capturedSignal = options.signal
        await gate
        return { handle: 'term_1', condition: 'exit', satisfied: false, status: 'aborted' }
      }
    }
    const { server, ws, deviceToken } = setUpServer(runtime as unknown as Partial<OrcaRuntimeService>)
    const replies: Record<string, unknown>[] = []

    try {
      const dispatchPromise = server['handleWebSocketMessage'](
        JSON.stringify({
          id: 'req_wait',
          method: 'terminal.wait',
          deviceToken,
          params: { terminal: 'term_1', for: 'exit' }
        }),
        (response) => replies.push(JSON.parse(response) as Record<string, unknown>),
        () => {},
        undefined,
        ws as unknown as WebSocket
      )

      await waitFor(() => capturedSignal !== undefined)
      expect(capturedSignal).toBeInstanceOf(AbortSignal)
      expect(capturedSignal?.aborted).toBe(false)

      ws.readyState = 3
      ws.emit('close')

      expect(capturedSignal?.aborted).toBe(true)
      resolveGate?.()
      await dispatchPromise
    } finally {
      await server.stop()
    }
  })

  it('a runtime that refuses a disconnected caller still completes a create whose socket closed mid-flight', async () => {
    let capturedCaller: RuntimeAgentSessionRpcCaller | undefined
    let resolveGate: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      resolveGate = resolve
    })
    const runtime = {
      getRuntimeId: () => 'runtime-1',
      createAgentSession: async (_params: unknown, caller?: RuntimeAgentSessionRpcCaller) => {
        capturedCaller = caller
        await gate
        // Why: mirrors the pre-Phase-3 runtime guard, so re-wiring the socket signal into a launch turns this red (03-05 M10).
        if ((caller as unknown as { signal?: AbortSignal } | undefined)?.signal?.aborted) {
          throw new Error('client_disconnected')
        }
        return {
          terminal: { handle: 'term_1', worktreeId: 'worktree-1', title: null },
          disposition: 'created' as const
        }
      }
    }
    const { server, ws, deviceToken } = setUpServer(runtime)
    const replies: Record<string, unknown>[] = []

    try {
      const dispatchPromise = server['handleWebSocketMessage'](
        JSON.stringify({
          id: 'req_create_e',
          method: 'terminal.createAgentSession',
          deviceToken,
          params: VALID_CREATE_AGENT_SESSION_PARAMS
        }),
        (response) => replies.push(JSON.parse(response) as Record<string, unknown>),
        () => {},
        undefined,
        ws as unknown as WebSocket
      )

      await waitFor(() => capturedCaller !== undefined)
      ws.readyState = 3
      ws.emit('close')
      resolveGate?.()
      await dispatchPromise

      expect(replies).toContainEqual(expect.objectContaining({ id: 'req_create_e', ok: true }))
      expect(replies.filter((reply) => reply.ok === false)).toEqual([])
    } finally {
      await server.stop()
    }
  })
})
