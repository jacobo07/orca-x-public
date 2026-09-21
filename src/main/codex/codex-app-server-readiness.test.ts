import { describe, expect, it } from 'vitest'

import {
  createCodexAppServerChildDouble,
  flushChildIo
} from './codex-app-server-child-double'
import { runCodexAppServerSession } from './codex-app-server-session'

// A SPAWNED PROCESS IS NOT A READY PROVIDER. Readiness is the handshake contract, and nothing that
// depends on the provider may run before it holds. These cases pin that, because the property is
// currently structural — `body` is called after `initialize` resolves — and a refactor that moved
// one line could lose it with nothing going red.

const INVOCATION = { command: 'codex', args: ['app-server'], timeoutMs: 5_000 }

describe('codex app-server readiness', () => {
  it('does not run the session body until initialize has been answered', async () => {
    const { double, spawnImpl } = createCodexAppServerChildDouble()
    let bodyRan = false

    const session = runCodexAppServerSession(
      INVOCATION,
      async () => {
        bodyRan = true
        return 'done'
      },
      spawnImpl
    )

    // The child exists and initialize has been sent. That is a spawn, not a ready provider.
    await double.waitForSend('initialize')
    await flushChildIo()
    expect(bodyRan, 'the body must not run against an unhandshaken provider').toBe(false)

    double.emit({ id: double.sent[0].id, result: {} })
    await expect(session).resolves.toBe('done')
    expect(bodyRan).toBe(true)
  })

  it('never runs the body when the handshake is refused', async () => {
    const { double, spawnImpl } = createCodexAppServerChildDouble()
    let bodyRan = false

    const session = runCodexAppServerSession(
      INVOCATION,
      async () => {
        bodyRan = true
        return 'done'
      },
      spawnImpl
    )

    await double.waitForSend('initialize')
    double.emit({ id: double.sent[0].id, error: { code: -32600, message: 'Invalid Request' } })

    await expect(session).rejects.toThrow(/initialize/)
    expect(bodyRan).toBe(false)
  })

  it('never runs the body when the provider dies during the handshake', async () => {
    const { double, spawnImpl } = createCodexAppServerChildDouble({ exitOnStdinEnd: false })
    let bodyRan = false

    const session = runCodexAppServerSession(
      INVOCATION,
      async () => {
        bodyRan = true
        return 'done'
      },
      spawnImpl
    )

    await double.waitForSend('initialize')
    double.emitStderr('error: unrecognized subcommand "app-server"')
    await flushChildIo()
    double.exit(2)

    await expect(session).rejects.toThrow()
    expect(bodyRan).toBe(false)
  })

  it('fails a pending request when the provider exits mid-session', async () => {
    // A turn in flight must not hang forever because the peer went away.
    const { double, spawnImpl } = createCodexAppServerChildDouble({ exitOnStdinEnd: false })

    const session = runCodexAppServerSession(
      INVOCATION,
      async (rpc) => rpc.request('turn/start', { threadId: 't' }),
      spawnImpl
    )

    await double.waitForSend('initialize')
    double.emit({ id: double.sent[0].id, result: {} })
    await double.waitForSend('turn/start')
    double.exit(1)

    await expect(session).rejects.toThrow(/exited before completing the session/)
  })
})
