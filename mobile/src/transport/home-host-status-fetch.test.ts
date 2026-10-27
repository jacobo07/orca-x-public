import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchHomeHostStatus, type HomeHostStatusSnapshot } from './home-host-status-fetch'
import type { RpcClient } from './rpc-client'
import { LogicalClientCutoverError } from './stable-logical-rpc-client'
import type { ConnectionState, RpcResponse } from './types'

type FakeSession = {
  client: RpcClient
  calls: Array<{ method: string; params: unknown }>
  settle: (response: RpcResponse | Error) => void
}

function fakeSession(): FakeSession {
  const pending: Array<(response: RpcResponse | Error) => void> = []
  const fake: FakeSession = {
    calls: [],
    settle(response: RpcResponse | Error) {
      pending.shift()?.(response)
    },
    client: {
      sendRequest: (method: string, params?: unknown) => {
        fake.calls.push({ method, params })
        return new Promise<RpcResponse>((resolve, reject) => {
          pending.push((response) =>
            response instanceof Error ? reject(response) : resolve(response)
          )
        })
      },
      subscribe: () => () => {},
      updateTerminalSubscriptionViewport: () => {},
      getState: (): ConnectionState => 'connected',
      getReconnectAttempt: () => 0,
      getLastConnectedAt: () => null,
      onStateChange: () => () => {},
      notifyForeground: () => {},
      close: () => {}
    }
  }
  return fake
}

// Drains the promise chain so a retry queued in a .catch has reached the transport.
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

function okResponse(result: unknown): RpcResponse {
  return { id: 'r', ok: true, result, _meta: { runtimeId: 'rt' } }
}

function failResponse(): RpcResponse {
  return {
    id: 'r',
    ok: false,
    error: { code: 'internal', message: 'boom' },
    _meta: { runtimeId: 'rt' }
  }
}

function statusStore(initial: Record<string, HomeHostStatusSnapshot> = {}) {
  let state = initial
  return {
    get current() {
      return state
    },
    setStatus(
      updater: (
        prev: Record<string, HomeHostStatusSnapshot>
      ) => Record<string, HomeHostStatusSnapshot>
    ) {
      state = updater(state)
    }
  }
}

const notDisposed = () => false

describe('fetchHomeHostStatus', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('stores the answer and when it was observed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(5000)
    const store = statusStore()
    const host = fakeSession()

    const done = fetchHomeHostStatus(host.client, 'host-1', store.setStatus, notDisposed)
    host.settle(okResponse({ graphStatus: 'ready' }))
    await done

    expect(host.calls).toEqual([{ method: 'status.get', params: undefined }])
    expect(store.current['host-1']).toEqual({ observedAt: 5000, result: { graphStatus: 'ready' } })
  })

  it('keeps the previous snapshot by identity when the host answers !ok', async () => {
    const previous: HomeHostStatusSnapshot = { observedAt: 1, result: { graphStatus: 'ready' } }
    const store = statusStore({ 'host-1': previous })
    const host = fakeSession()

    const done = fetchHomeHostStatus(host.client, 'host-1', store.setStatus, notDisposed)
    host.settle(failResponse())
    await done

    expect(store.current['host-1']).toBe(previous)
  })

  it('keeps the previous snapshot by identity when the read rejects', async () => {
    const previous: HomeHostStatusSnapshot = { observedAt: 1, result: { graphStatus: 'ready' } }
    const store = statusStore({ 'host-1': previous })
    const host = fakeSession()

    const done = fetchHomeHostStatus(host.client, 'host-1', store.setStatus, notDisposed)
    host.settle(new Error('socket closed mid-request'))
    await done

    expect(store.current['host-1']).toBe(previous)
    expect(host.calls).toHaveLength(1)
  })

  it('re-asks after a cutover at most twice', async () => {
    const store = statusStore()
    const host = fakeSession()

    const done = fetchHomeHostStatus(host.client, 'host-1', store.setStatus, notDisposed)
    for (let i = 0; i < 4; i += 1) {
      host.settle(new LogicalClientCutoverError())
      await flush()
    }
    await done

    expect(host.calls).toHaveLength(3)
    expect(store.current['host-1']).toBeUndefined()
  })

  it('lands the answer from the replacement session after one cutover', async () => {
    const store = statusStore()
    const host = fakeSession()

    const done = fetchHomeHostStatus(host.client, 'host-1', store.setStatus, notDisposed)
    host.settle(new LogicalClientCutoverError())
    await flush()
    host.settle(okResponse({ graphStatus: 'reloading' }))
    await done

    expect(host.calls).toHaveLength(2)
    expect(store.current['host-1']?.result).toEqual({ graphStatus: 'reloading' })
  })

  it('drops the answer once disposed', async () => {
    const store = statusStore()
    const host = fakeSession()
    let disposed = false

    const done = fetchHomeHostStatus(host.client, 'host-1', store.setStatus, () => disposed)
    disposed = true
    host.settle(okResponse({ graphStatus: 'ready' }))
    await done

    expect(store.current).toEqual({})
  })
})
