import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createRemoteRuntimeTransportMocks,
  type MultiplexSubscriptionCallbacks
} from './remote-runtime-pty-transport-test-harness'

let subscriptionCallbacks: MultiplexSubscriptionCallbacks = null
let resolvedPaneHandle = 'terminal-1'

const { runtimeCall, subscriptionSendBinary, resetRemoteRuntimeTransport } =
  createRemoteRuntimeTransportMocks({
    getCallbacks: () => subscriptionCallbacks,
    setCallbacks: (callbacks) => {
      subscriptionCallbacks = callbacks
    },
    getResolvedPaneHandle: () => resolvedPaneHandle,
    setResolvedPaneHandle: (handle) => {
      resolvedPaneHandle = handle
    }
  })

// Why: a renderer test cannot import src/main, so the stop-class names are pinned by literal.
const STOP_CLASS_METHODS = new Set([
  'terminal.close',
  'terminal.closeTab',
  'terminal.stop',
  'terminal.stopExact',
  'terminal.sleep',
  'worktree.sleep',
  'session.tabs.close',
  'session.tabs.closeLifecycle'
])

function isStopClass(method: unknown): boolean {
  if (typeof method !== 'string') {
    return false
  }
  return STOP_CLASS_METHODS.has(method) || method.split('.').at(-1) === 'kill'
}

function methodsCalledSince(start: number): string[] {
  return runtimeCall.mock.calls.slice(start).map(([args]) => String(args?.method))
}

async function drain(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve()
  }
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('dws Phase 3: a remote pane teardown is Detach - it sends the runtime no Stop', () => {
  beforeEach(() => {
    resetRemoteRuntimeTransport()
  })

  it('positive control: the spy and matcher see the orphan cleanup terminal.close', async () => {
    let resolveCreate: (value: unknown) => void = () => {}
    runtimeCall.mockImplementation((args) => {
      if (args.method === 'terminal.create') {
        return new Promise((resolve) => {
          resolveCreate = resolve
        })
      }
      return Promise.resolve({ ok: true, result: {} })
    })
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1'
    })

    const connect = transport.connect({ url: '', callbacks: {} })
    transport.destroy?.()
    resolveCreate({ ok: true, result: { terminal: { handle: 'terminal-late' } } })
    await connect

    const methods = methodsCalledSince(0)
    expect(methods).toContain('terminal.close')
    expect(methods.some(isStopClass)).toBe(true)
  })

  it('matcher control: observation methods are not stop-class', () => {
    expect(isStopClass('terminal.close')).toBe(true)
    expect(isStopClass('terminal.kill')).toBe(true)
    expect(isStopClass('terminal.multiplex')).toBe(false)
    expect(isStopClass('terminal.subscribe')).toBe(false)
    expect(isStopClass('status.get')).toBe(false)
  })

  it.each(['disconnect', 'detach', 'destroy'] as const)(
    'an attached transport sends no stop-class RPC on %s',
    async (teardown) => {
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const transport = createRemoteRuntimePtyTransport('env-1', {
        worktreeId: 'wt-1',
        tabId: 'tab-1',
        leafId: 'pane:1'
      })
      transport.attach({ existingPtyId: 'remote:env-1@@terminal-1', callbacks: {} })
      await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
      await drain()
      const before = runtimeCall.mock.calls.length

      await transport[teardown]?.()
      await drain()

      const methods = methodsCalledSince(before)
      expect(methods.filter(isStopClass)).toEqual([])
      transport.destroy?.()
    }
  )
})
