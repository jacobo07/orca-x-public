import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HomeHostStatusSnapshot } from './home-host-status-fetch'
import {
  advertisesWakeBroker,
  brokerRouteInputs,
  fetchHomeHostWakeTargets,
  hostKeyOfPublicKey,
  hostsAskableForWakeTargets,
  planHostWakePress,
  pressHostWake,
  requestHostWake,
  shouldFetchWakeTargets,
  type HomeHostWakeTargetsSnapshot
} from './home-host-wake-session'
import type { RpcClient } from './rpc-client'
import type { ConnectionState, HostProfile, RpcResponse } from './types'

vi.mock('expo-crypto', () => ({ randomUUID: () => globalThis.crypto.randomUUID() }))

// 21-02 pinned vector: the 32 bytes 0x00..0x1f and the host's own fingerprint of them.
const VECTOR_PUBLIC_KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8='
const VECTOR_HOST_KEY = 'Yw3NKWbEM2aRElRIu7JbT_QSpJxzLbLIq8G4WBvXEN0'
const OTHER_PUBLIC_KEY = btoa(String.fromCharCode(...Array.from({ length: 32 }, () => 1)))
const TARGET_ID = 'wt_0123456789ab'

type FakeSession = {
  client: RpcClient
  calls: Array<{ method: string; params: unknown }>
  settle: (response: RpcResponse | Error) => void
}

function fakeSession(state: ConnectionState = 'connected'): FakeSession {
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
      getState: () => state,
      getReconnectAttempt: () => 0,
      getLastConnectedAt: () => null,
      onStateChange: () => () => {},
      notifyForeground: () => {},
      close: () => {}
    }
  }
  return fake
}

function okResponse(result: unknown): RpcResponse {
  return { id: 'r', ok: true, result, _meta: { runtimeId: 'rt' } }
}

function failResponse(code: string, data?: unknown): RpcResponse {
  return {
    id: 'r',
    ok: false,
    error: { code, message: 'refused', ...(data === undefined ? {} : { data }) },
    _meta: { runtimeId: 'rt' }
  }
}

function phoneClock(start: number): () => number {
  let tick = start
  return () => tick++
}

const CONNECTED_AT = 1_000
const BROKER_STATUS: HomeHostStatusSnapshot = {
  observedAt: 2_000,
  result: { capabilities: ['host.wake-broker.v1'] }
}
const PLAIN_STATUS: HomeHostStatusSnapshot = { observedAt: 2_000, result: { capabilities: [] } }
const BOUND_TARGETS: HomeHostWakeTargetsSnapshot = {
  observedAt: 2_100,
  targets: [{ targetId: TARGET_ID, label: 'desk', hostKey: VECTOR_HOST_KEY }]
}
const UNBOUND_TARGETS: HomeHostWakeTargetsSnapshot = {
  observedAt: 2_100,
  targets: [{ targetId: TARGET_ID, label: 'desk' }]
}
const PRESS_STAGES = [
  { stage: 'requested', observedAt: 90, observer: 'broker' },
  { stage: 'authorized', observedAt: 91, observer: 'broker' },
  { stage: 'packet-sent', observedAt: 92, observer: 'broker' }
]

function sessionBrokers(targets: HomeHostWakeTargetsSnapshot | undefined) {
  return brokerRouteInputs([
    {
      hostId: 'host-a',
      connected: true,
      lastConnectedAt: CONNECTED_AT,
      status: BROKER_STATUS,
      targets
    },
    {
      hostId: 'host-t',
      connected: true,
      lastConnectedAt: CONNECTED_AT,
      status: PLAIN_STATUS,
      targets: undefined
    }
  ])
}

function targetsStore(initial: Record<string, HomeHostWakeTargetsSnapshot> = {}) {
  let state = initial
  return {
    get current() {
      return state
    },
    setTargets(
      updater: (
        prev: Record<string, HomeHostWakeTargetsSnapshot>
      ) => Record<string, HomeHostWakeTargetsSnapshot>
    ) {
      state = updater(state)
    }
  }
}

const notDisposed = () => false

afterEach(() => {
  vi.useRealTimers()
})

describe('hostKeyOfPublicKey', () => {
  it('derives the 21-02 pinned vector with the phone sha256', () => {
    expect(hostKeyOfPublicKey(VECTOR_PUBLIC_KEY)).toBe(VECTOR_HOST_KEY)
  })

  it('returns null for a key the host would not fingerprint', () => {
    expect(hostKeyOfPublicKey('not a key')).toBeNull()
    expect(hostKeyOfPublicKey(btoa('short'))).toBeNull()
  })
})

describe('which hosts are asked for wake targets', () => {
  it('reads host.wake-broker.v1 only from a status record with a capabilities array', () => {
    expect(advertisesWakeBroker(BROKER_STATUS)).toBe(true)
    expect(advertisesWakeBroker(PLAIN_STATUS)).toBe(false)
    expect(advertisesWakeBroker(undefined)).toBe(false)
    expect(advertisesWakeBroker({ observedAt: 1, result: null })).toBe(false)
    const notArray = { observedAt: 1, result: { capabilities: 'host.wake-broker.v1' } }
    expect(advertisesWakeBroker(notArray)).toBe(false)
  })

  it('asks once per status answer: not again once targets answered at or after it', () => {
    expect(shouldFetchWakeTargets(BROKER_STATUS, undefined)).toBe(true)
    expect(shouldFetchWakeTargets(BROKER_STATUS, { observedAt: 1_999, targets: [] })).toBe(true)
    expect(shouldFetchWakeTargets(BROKER_STATUS, { observedAt: 2_000, targets: [] })).toBe(false)
    expect(shouldFetchWakeTargets(BROKER_STATUS, BOUND_TARGETS)).toBe(false)
    expect(shouldFetchWakeTargets(PLAIN_STATUS, undefined)).toBe(false)
    expect(shouldFetchWakeTargets(undefined, undefined)).toBe(false)
  })

  it('selects only a connected host whose current status advertises the broker', () => {
    const broker = fakeSession()
    const plain = fakeSession()
    const offline = fakeSession('reconnecting')
    const askable = hostsAskableForWakeTargets({
      clients: [
        { hostId: 'host-a', client: broker.client },
        { hostId: 'host-p', client: plain.client },
        { hostId: 'host-o', client: offline.client }
      ],
      statuses: { 'host-a': BROKER_STATUS, 'host-p': PLAIN_STATUS, 'host-o': BROKER_STATUS },
      targets: {}
    })
    expect(askable.map((entry) => entry.hostId)).toEqual(['host-a'])
  })
})

describe('fetchHomeHostWakeTargets', () => {
  it('asks host.wake.targets and stamps the raw answer with the phone clock', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(7_000)
    const store = targetsStore()
    const broker = fakeSession()

    const done = fetchHomeHostWakeTargets(broker.client, 'host-a', store.setTargets, notDisposed)
    broker.settle(okResponse(BOUND_TARGETS.targets))
    await done

    expect(broker.calls).toEqual([{ method: 'host.wake.targets', params: undefined }])
    expect(store.current['host-a']).toEqual({ observedAt: 7_000, targets: BOUND_TARGETS.targets })
  })

  it('keeps the previous answer by identity on a refusal', async () => {
    const store = targetsStore({ 'host-a': BOUND_TARGETS })
    const broker = fakeSession()

    const done = fetchHomeHostWakeTargets(broker.client, 'host-a', store.setTargets, notDisposed)
    broker.settle(failResponse('wake_broker_disabled'))
    await done

    expect(store.current['host-a']).toBe(BOUND_TARGETS)
  })
})

describe('a press on a bound card', () => {
  it('sends exactly one host.wake.request to the broker that answered, none to the target', async () => {
    const broker = fakeSession()
    const target = fakeSession()
    const plan = planHostWakePress({
      targetHostId: 'host-t',
      hostKey: hostKeyOfPublicKey(VECTOR_PUBLIC_KEY),
      brokers: sessionBrokers(BOUND_TARGETS),
      clients: [
        { hostId: 'host-a', client: broker.client },
        { hostId: 'host-t', client: target.client }
      ]
    })
    expect(plan).toEqual({ client: broker.client, brokerHostId: 'host-a', targetId: TARGET_ID })
    const pressed = vi.fn()

    const done = requestHostWake({
      ...plan!,
      requestId: 'req-00000001',
      now: phoneClock(5_000),
      onPressed: pressed
    })
    expect(pressed).toHaveBeenCalledWith(
      expect.objectContaining({ pressedAt: 5_000, repliedAt: null, requestId: 'req-00000001' })
    )
    broker.settle(
      okResponse({ wakeId: 'wake-1', targetId: TARGET_ID, replayed: false, stages: PRESS_STAGES })
    )
    const attempt = await done

    expect(broker.calls).toEqual([
      { method: 'host.wake.request', params: { targetId: TARGET_ID, requestId: 'req-00000001' } }
    ])
    expect(target.calls).toEqual([])
    expect(attempt).toEqual({
      brokerHostId: 'host-a',
      targetId: TARGET_ID,
      requestId: 'req-00000001',
      pressedAt: 5_000,
      repliedAt: 5_001,
      wakeId: 'wake-1',
      brokerStages: PRESS_STAGES,
      refusalCode: null
    })
  })

  it('mints a fresh requestId for every press', async () => {
    const broker = fakeSession()
    const press = () =>
      pressHostWake({
        target: { id: 'host-t', publicKeyB64: VECTOR_PUBLIC_KEY },
        brokers: sessionBrokers(BOUND_TARGETS),
        clients: [{ hostId: 'host-a', client: broker.client }],
        now: phoneClock(5_000)
      })

    const first = press()
    broker.settle(okResponse({ wakeId: 'wake-1', stages: PRESS_STAGES }))
    await first
    const second = press()
    broker.settle(okResponse({ wakeId: 'wake-2', stages: PRESS_STAGES }))
    await second

    const ids = broker.calls.map((call) => (call.params as { requestId: string }).requestId)
    expect(broker.calls.map((call) => call.method)).toEqual([
      'host.wake.request',
      'host.wake.request'
    ])
    expect(ids[0]).not.toBe(ids[1])
    expect(ids.every((id) => id.length >= 8 && id.length <= 128)).toBe(true)
  })

  it('sends nothing when the entry is unbound', () => {
    const broker = fakeSession()
    const target = fakeSession()
    const clients = [
      { hostId: 'host-a', client: broker.client },
      { hostId: 'host-t', client: target.client }
    ]
    const brokers = sessionBrokers(UNBOUND_TARGETS)

    expect(
      planHostWakePress({
        targetHostId: 'host-t',
        hostKey: hostKeyOfPublicKey(VECTOR_PUBLIC_KEY),
        brokers,
        clients
      })
    ).toBeNull()
    expect(
      pressHostWake({
        target: { id: 'host-t', publicKeyB64: VECTOR_PUBLIC_KEY },
        brokers,
        clients,
        now: phoneClock(5_000)
      })
    ).toBeNull()
    expect(broker.calls).toEqual([])
    expect(target.calls).toEqual([])
  })

  it('sends nothing when the routed broker has no registered client', () => {
    const target = fakeSession()
    expect(
      planHostWakePress({
        targetHostId: 'host-t',
        hostKey: hostKeyOfPublicKey(VECTOR_PUBLIC_KEY),
        brokers: sessionBrokers(BOUND_TARGETS),
        clients: [{ hostId: 'host-t', client: target.client }]
      })
    ).toBeNull()
    expect(target.calls).toEqual([])
  })

  it('routes a relay-reached profile by publicKeyB64 alone', async () => {
    const relayProfile: HostProfile = {
      id: 'host-t-relay',
      name: 'desk',
      endpoint: 'wss://relay-c1.onorca.dev/v1/connect',
      deviceToken: 'token',
      publicKeyB64: VECTOR_PUBLIC_KEY,
      lastConnected: 0,
      relayHostId: 'AbCdEf0123_-xyZ9',
      relay: {
        v: 1,
        directorUrl: 'https://relay.onorca.dev',
        cellUrl: 'https://relay-c1.onorca.dev',
        assignmentEpoch: 7,
        relayHostId: 'AbCdEf0123_-xyZ9',
        e2eeFraming: 2
      }
    }
    const broker = fakeSession()
    const clients = [{ hostId: 'host-a', client: broker.client }]
    const brokers = sessionBrokers(BOUND_TARGETS)

    // Same relay, endpoint and id with another key: nothing but the key may route it.
    expect(
      pressHostWake({
        target: { ...relayProfile, publicKeyB64: OTHER_PUBLIC_KEY },
        brokers,
        clients,
        now: phoneClock(5_000)
      })
    ).toBeNull()
    const done = pressHostWake({ target: relayProfile, brokers, clients, now: phoneClock(5_000) })
    expect(done).not.toBeNull()
    broker.settle(okResponse({ wakeId: 'wake-1', stages: PRESS_STAGES }))
    const attempt = await done

    expect(broker.calls).toHaveLength(1)
    expect(broker.calls[0]?.params).toMatchObject({ targetId: TARGET_ID })
    expect(attempt).toMatchObject({ brokerHostId: 'host-a', targetId: TARGET_ID, wakeId: 'wake-1' })
  })
})
