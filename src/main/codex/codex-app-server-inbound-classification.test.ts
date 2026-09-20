import { describe, expect, it } from 'vitest'

import {
  createCodexAppServerChildDouble,
  flushChildIo
} from './codex-app-server-child-double'
import { runCodexAppServerSession } from './codex-app-server-session'

// An inbound line is classified by DIRECTION and SHAPE, never by the presence of an id. Codex
// app-server is a bidirectional peer: its 11 server requests (approvals among them) carry an id
// of their own, numbered in the server's own space, so `id` alone cannot say whether a message
// answers us or asks us something.

const INVOCATION = { command: 'codex', args: ['app-server'], timeoutMs: 5_000 }

/** Settles to the client's own id for a sent method, so a case never hardcodes the numbering. */
function sentIdFor(sent: Record<string, unknown>[], method: string): number {
  const line = sent.find((entry) => entry.method === method)
  if (!line || typeof line.id !== 'number') {
    throw new Error(`the client never sent a request for ${method}`)
  }
  return line.id
}

describe('codex app-server inbound classification', () => {
  it('CONTROL: a genuine response still settles its own request', async () => {
    // Without this, a transport that delivered nothing at all would satisfy every "was not
    // consumed" assertion below and read as correct.
    const { double, spawnImpl } = createCodexAppServerChildDouble()

    const session = runCodexAppServerSession(
      INVOCATION,
      async (rpc) => rpc.request('thread/start', { cwd: '/repo' }),
      spawnImpl
    )

    await double.waitForSend('initialize')
    double.emit({ id: sentIdFor(double.sent, 'initialize'), result: {} })
    const started = await double.waitForSend('thread/start')
    double.emit({ id: started.id, result: { threadId: 'thread-1' } })

    await expect(session).resolves.toEqual({ threadId: 'thread-1' })
  })

  it('does not answer a client request with a server request that reuses its id', async () => {
    // The server numbers its own requests from its own space, so a collision is ordinary traffic,
    // not an edge case. Correlating on id alone hands `turn/start` the APPROVAL as its result:
    // the caller sees `undefined`, the approval is never answered, and the real response is then
    // dropped because nothing is waiting for it any more.
    const { double, spawnImpl } = createCodexAppServerChildDouble()

    const session = runCodexAppServerSession(
      INVOCATION,
      async (rpc) => rpc.request('turn/start', { threadId: 'thread-1', input: 'hi' }),
      spawnImpl
    )

    await double.waitForSend('initialize')
    double.emit({ id: sentIdFor(double.sent, 'initialize'), result: {} })
    const turn = await double.waitForSend('turn/start')

    // The server asks us something while our own request is still in flight, using ITS id 1 —
    // which is also ours.
    double.emit({
      id: turn.id,
      method: 'item/commandExecution/requestApproval',
      params: { command: 'ls' }
    })
    await flushChildIo()

    // Only now does the real answer arrive.
    double.emit({ id: turn.id, result: { turnId: 'turn-1' } })

    await expect(session).resolves.toEqual({ turnId: 'turn-1' })
  })

  it('surfaces a notification that arrives during the handshake', async () => {
    // The case that motivated the sink: W0 saw `remoteControl/status/changed` before any product
    // request existed. A sink the session body installs would already have missed it.
    const { double, spawnImpl } = createCodexAppServerChildDouble()
    const seen: { method: string; params: unknown }[] = []

    const session = runCodexAppServerSession(INVOCATION, async () => 'done', spawnImpl, {
      onNotification: (notification) => seen.push(notification)
    })

    await double.waitForSend('initialize')
    double.emit({ method: 'remoteControl/status/changed', params: { status: 'connected' } })
    await flushChildIo()
    double.emit({ id: sentIdFor(double.sent, 'initialize'), result: {} })

    await expect(session).resolves.toBe('done')
    expect(seen).toEqual([
      { method: 'remoteControl/status/changed', params: { status: 'connected' } }
    ])
  })

  it('answers an unhandled server request with an error rather than silence', async () => {
    // Fail closed. Silence blocks the peer forever; a result would be an answer Orca never gave.
    const { double, spawnImpl } = createCodexAppServerChildDouble()

    const session = runCodexAppServerSession(INVOCATION, async () => 'done', spawnImpl)

    await double.waitForSend('initialize')
    double.emit({ id: sentIdFor(double.sent, 'initialize'), result: {} })
    double.emit({ id: 900, method: 'item/fileChange/requestApproval', params: { path: '/x' } })
    await flushChildIo()

    await expect(session).resolves.toBe('done')
    const answer = double.sent.find((line) => line.id === 900)
    expect(answer).toBeDefined()
    expect(answer).not.toHaveProperty('result')
    expect((answer as { error: { code: number } }).error.code).toBe(-32601)
  })

  it('answers a server request exactly once when its id is repeated', async () => {
    const { double, spawnImpl } = createCodexAppServerChildDouble()
    let handled = 0
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    const session = runCodexAppServerSession(INVOCATION, async () => 'done', spawnImpl, {
      onServerRequest: async () => {
        handled += 1
        await gate
        return { outcome: 'result', result: { decision: 'approved' } }
      }
    })

    await double.waitForSend('initialize')
    double.emit({ id: sentIdFor(double.sent, 'initialize'), result: {} })
    double.emit({ id: 7, method: 'item/commandExecution/requestApproval', params: {} })
    await flushChildIo()
    // The same id again while the first is still being decided.
    double.emit({ id: 7, method: 'item/commandExecution/requestApproval', params: {} })
    await flushChildIo()
    release?.()

    await expect(session).resolves.toBe('done')
    expect(handled).toBe(1)
    expect(double.sent.filter((line) => line.id === 7)).toHaveLength(1)
  })

  it('answers with an error when the handler throws', async () => {
    const { double, spawnImpl } = createCodexAppServerChildDouble()

    const session = runCodexAppServerSession(INVOCATION, async () => 'done', spawnImpl, {
      onServerRequest: async () => {
        throw new Error('authority unavailable')
      }
    })

    await double.waitForSend('initialize')
    double.emit({ id: sentIdFor(double.sent, 'initialize'), result: {} })
    double.emit({ id: 11, method: 'item/permissions/requestApproval', params: {} })
    await flushChildIo()

    await expect(session).resolves.toBe('done')
    const answer = double.sent.find((line) => line.id === 11) as { error?: { code: number } }
    expect(answer?.error?.code).toBe(-32603)
  })

  it('survives an unparsable line and reports it', async () => {
    const { double, spawnImpl } = createCodexAppServerChildDouble()
    const diagnostics: string[] = []

    const session = runCodexAppServerSession(
      INVOCATION,
      async (rpc) => rpc.request('thread/start', {}),
      spawnImpl,
      { onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.kind) }
    )

    await double.waitForSend('initialize')
    double.emit({ id: sentIdFor(double.sent, 'initialize'), result: {} })
    const started = await double.waitForSend('thread/start')
    double.emitRaw('{ this is not json }\n')
    await flushChildIo()
    double.emit({ id: started.id, result: { threadId: 'thread-2' } })

    await expect(session).resolves.toEqual({ threadId: 'thread-2' })
    expect(diagnostics).toContain('unparsable-line')
  })
})
