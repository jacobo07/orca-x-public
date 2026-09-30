import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import type WebSocket from 'ws'
import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import { ALL_RPC_METHODS } from './index'
import { TERMINAL_METHODS } from './terminal'
import { WORKSTREAM_CANCEL_METHODS } from './workstream-cancel'
import { OrcaRuntimeRpcServer } from '../../runtime-rpc'
import { DeviceRegistry } from '../../device-registry'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcAnyMethod } from '../core'

const STOP_SPY_NAMES = [
  'stopTerminalsForWorktree',
  'stopExactTerminalsForWorktree',
  'sleepTerminalsForWorktree',
  'closeTerminal',
  'closeTerminalTab'
] as const

function makeRuntime(implementation?: () => unknown) {
  const spies = Object.fromEntries(
    STOP_SPY_NAMES.map((name) => [
      name,
      vi.fn(
        implementation ??
          (() => {
            throw new Error('stop effect reached')
          })
      )
    ])
  ) as Record<(typeof STOP_SPY_NAMES)[number], ReturnType<typeof vi.fn>>
  return { runtime: { getRuntimeId: () => 'runtime-1', ...spies }, spies }
}

function dispatcherFor(runtime: unknown, methods?: readonly RpcAnyMethod[]) {
  return new RpcDispatcher({ runtime: runtime as OrcaRuntimeService, methods })
}

function anySpyCalled(spies: Record<string, ReturnType<typeof vi.fn>>): boolean {
  return Object.values(spies).some((spy) => spy.mock.calls.length > 0)
}

const REQUEST = { id: 'req_1', authToken: 't', method: 'workstream.cancel' }

describe('workstream.cancel', () => {
  it('refuses with workstream_authority_unavailable naming uwcp.control/1 and reaches no stop effect', async () => {
    const { runtime, spies } = makeRuntime()
    const response = await dispatcherFor(runtime).dispatch({
      ...REQUEST,
      params: { workstreamId: 'ws-1' }
    })

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: 'workstream_authority_unavailable',
        data: { authority: 'uwcp.control/1' }
      }
    })
    expect(anySpyCalled(spies)).toBe(false)
  })

  it('rejects an unknown extra key as invalid_argument without reaching a stop effect', async () => {
    const { runtime, spies } = makeRuntime()
    const response = await dispatcherFor(runtime).dispatch({
      ...REQUEST,
      params: { workstreamId: 'ws-1', worktree: 'id:worktree-1' }
    })

    expect(response).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    expect(anySpyCalled(spies)).toBe(false)
  })

  it('an old host without the method answers method_not_found and stops nothing', async () => {
    const { runtime, spies } = makeRuntime()
    const oldHostMethods = ALL_RPC_METHODS.filter(
      (method) => !WORKSTREAM_CANCEL_METHODS.some((cancel) => cancel.name === method.name)
    )
    // Station control: the filter removed exactly the cancel method and left the registry populated.
    expect(oldHostMethods.length).toBe(ALL_RPC_METHODS.length - WORKSTREAM_CANCEL_METHODS.length)
    expect(ALL_RPC_METHODS.some((m) => m.name === 'workstream.cancel')).toBe(true)

    const response = await dispatcherFor(runtime, oldHostMethods).dispatch({
      ...REQUEST,
      params: { workstreamId: 'ws-1' }
    })

    expect(response).toMatchObject({ ok: false, error: { code: 'method_not_found' } })
    expect(anySpyCalled(spies)).toBe(false)
  })

  it('a Stop request never reaches the Cancel handler and carries no Cancel code', async () => {
    const { runtime, spies } = makeRuntime(() => ({ stopped: 1 }))
    const cancelHandler = vi.fn()
    const wrappedCancel = WORKSTREAM_CANCEL_METHODS.map((method) => ({
      ...method,
      handler: cancelHandler
    }))
    const stopMethods = TERMINAL_METHODS.filter((method) => method.name === 'terminal.stopExact')
    expect(stopMethods).toHaveLength(1)

    const response = await dispatcherFor(runtime, [...stopMethods, ...wrappedCancel]).dispatch({
      id: 'req_stop',
      authToken: 't',
      method: 'terminal.stopExact',
      params: { worktree: 'id:worktree-1', expectedPtyIds: ['pty-1'] }
    })

    expect(response.ok).toBe(true)
    expect(spies.stopExactTerminalsForWorktree).toHaveBeenCalledTimes(1)
    expect(cancelHandler).not.toHaveBeenCalled()
    expect(JSON.stringify(response)).not.toContain('workstream_authority_unavailable')
  })
})

class FakeWebSocket extends EventEmitter {
  readonly OPEN = 1
  readyState = this.OPEN
}

async function cancelOverTheWire(scope: 'runtime' | 'mobile') {
  const { runtime } = makeRuntime()
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-workstream-cancel-'))
  const server = new OrcaRuntimeRpcServer({
    runtime: runtime as unknown as OrcaRuntimeService,
    userDataPath,
    enableWebSocket: false
  })
  server['deviceRegistry'] = new DeviceRegistry(userDataPath)
  const entry = server['deviceRegistry']!.addDevice(`${scope}-test`, scope)
  server['mobileSocketWiring'] = {
    getConnectionId: () => 'conn-test'
  } as unknown as NonNullable<(typeof server)['mobileSocketWiring']>
  const replies: Record<string, unknown>[] = []
  try {
    await server['handleWebSocketMessage'](
      JSON.stringify({
        id: 'req_cancel',
        method: 'workstream.cancel',
        deviceToken: entry.token,
        params: { workstreamId: 'ws-1' }
      }),
      (response) => replies.push(JSON.parse(response) as Record<string, unknown>),
      () => {},
      undefined,
      new FakeWebSocket() as unknown as WebSocket
    )
  } finally {
    await server.stop()
  }
  return replies
}

describe('workstream.cancel over the websocket', () => {
  it('a runtime-scope device receives the authority refusal', async () => {
    const replies = await cancelOverTheWire('runtime')
    expect(replies).toContainEqual(
      expect.objectContaining({
        id: 'req_cancel',
        ok: false,
        error: expect.objectContaining({ code: 'workstream_authority_unavailable' })
      })
    )
  })

  it('a mobile-scope device is refused forbidden (not on the mobile allowlist)', async () => {
    const replies = await cancelOverTheWire('mobile')
    expect(replies).toContainEqual(
      expect.objectContaining({
        id: 'req_cancel',
        ok: false,
        error: expect.objectContaining({ code: 'forbidden' })
      })
    )
  })
})
