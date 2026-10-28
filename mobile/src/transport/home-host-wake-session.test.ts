import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HostCardWakeAttempt } from '../components/host-availability-presentation'
import { namesDeviceRevocation } from './device-revocation-refusal'
import type { HomeHostStatusSnapshot } from './home-host-status-fetch'
import {
  advertisesWakeBroker,
  brokerRouteInputs,
  endedWakeAttempts,
  fetchHomeHostWakeTargets,
  hostKeyOfPublicKey,
  hostsAskableForWakeTargets,
  isWakeAttemptTerminal,
  planHostWakePress,
  pressHostWake,
  readHostWakeStatus,
  requestHostWake,
  shouldFetchWakeTargets,
  wakeAttemptForPairing,
  wakesToRefresh,
  type HomeHostWakeTargetsSnapshot
} from './home-host-wake-session'
import { connect, type RpcClient } from './rpc-client'
import type { ConnectionLogEntry, ConnectionState, HostProfile, RpcResponse } from './types'

vi.mock('expo-crypto', () => ({ randomUUID: () => globalThis.crypto.randomUUID() }))

// Why: the real RpcClient rows need a readable wire; the session module never touches e2ee.
vi.mock('./e2ee', () => ({
  generateKeyPair: () => ({ publicKey: new Uint8Array(32), secretKey: new Uint8Array(32) }),
  deriveSharedKey: () => new Uint8Array(32),
  publicKeyFromBase64: () => new Uint8Array(32),
  publicKeyToBase64: () => 'client-public-key',
  encrypt: (plaintext: string) => `encrypted:${plaintext}`,
  decrypt: (raw: string) => raw.replace(/^encrypted:/, ''),
  decryptBytes: (bytes: Uint8Array) => bytes
}))

// 21-02 pinned vector: the 32 bytes 0x00..0x1f and the host's own fingerprint of them.
const VECTOR_PUBLIC_KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8='
const VECTOR_HOST_KEY = 'Yw3NKWbEM2aRElRIu7JbT_QSpJxzLbLIq8G4WBvXEN0'
const OTHER_PUBLIC_KEY = btoa(String.fromCharCode(...Array.from({ length: 32 }, () => 1)))
const TARGET_ID = 'wt_0123456789ab'

type FakeSession = {
  client: RpcClient
  calls: Array<{ method: string; params: unknown }>
  options: unknown[]
  settle: (response: RpcResponse | Error) => void
}

function fakeSession(state: ConnectionState = 'connected'): FakeSession {
  const pending: Array<(response: RpcResponse | Error) => void> = []
  const fake: FakeSession = {
    calls: [],
    options: [],
    settle(response: RpcResponse | Error) {
      pending.shift()?.(response)
    },
    client: {
      sendRequest: (method: string, params?: unknown, options?: unknown) => {
        fake.calls.push({ method, params })
        fake.options.push(options)
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
// Why the wire shape: targetsFor answers { targets: [...] }; a bare-array fixture hid CR-01.
const WIRE_TARGETS_REPLY = { targets: BOUND_TARGETS.targets }
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
  it('asks host.wake.targets, unwraps the wire answer and stamps it with the phone clock', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(7_000)
    const store = targetsStore()
    const broker = fakeSession()

    const done = fetchHomeHostWakeTargets(broker.client, 'host-a', store.setTargets, notDisposed)
    broker.settle(okResponse(WIRE_TARGETS_REPLY))
    await done

    expect(broker.calls).toEqual([{ method: 'host.wake.targets', params: undefined }])
    expect(store.current['host-a']).toEqual({ observedAt: 7_000, targets: BOUND_TARGETS.targets })
  })

  it('a bound card routes from the stored wire answer', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(2_100)
    const store = targetsStore()
    const broker = fakeSession()

    const done = fetchHomeHostWakeTargets(broker.client, 'host-a', store.setTargets, notDisposed)
    broker.settle(okResponse(WIRE_TARGETS_REPLY))
    await done

    expect(
      planHostWakePress({
        targetHostId: 'host-t',
        hostKey: VECTOR_HOST_KEY,
        brokers: sessionBrokers(store.current['host-a']),
        clients: [{ hostId: 'host-a', client: broker.client }]
      })
    ).toEqual({ client: broker.client, brokerHostId: 'host-a', targetId: TARGET_ID })
  })

  it('stores an answer without a targets array as unreadable, never as targets', async () => {
    const store = targetsStore()
    const broker = fakeSession()

    const done = fetchHomeHostWakeTargets(broker.client, 'host-a', store.setTargets, notDisposed)
    broker.settle(okResponse({ targets: 'wt_0123456789ab' }))
    await done

    expect(store.current['host-a']?.targets).toBeNull()
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

  it('sends nothing when the routed broker client is not connected right now (WR-02)', () => {
    const broker = fakeSession('reconnecting')
    const press = pressHostWake({
      target: { id: 'host-t', publicKeyB64: VECTOR_PUBLIC_KEY },
      brokers: sessionBrokers(BOUND_TARGETS),
      clients: [{ hostId: 'host-a', client: broker.client }],
      now: phoneClock(5_000)
    })

    expect(press).toBeNull()
    expect(broker.calls).toEqual([])
  })

  it('bounds every wake rpc: no connect wait, and a deadline (WR-02)', async () => {
    const broker = fakeSession()
    const done = requestHostWake({
      client: broker.client,
      brokerHostId: 'host-a',
      targetId: TARGET_ID,
      requestId: 'req-00000001',
      now: phoneClock(5_000)
    })
    broker.settle(okResponse({ wakeId: 'wake-1', stages: PRESS_STAGES }))
    const read = readHostWakeStatus({ client: broker.client, attempt: await done })
    broker.settle(okResponse({ wakeId: 'wake-1', stages: PRESS_STAGES }))
    await read

    expect(broker.calls.map((call) => call.method)).toEqual([
      'host.wake.request',
      'host.wake.status'
    ])
    expect(broker.options).toHaveLength(2)
    for (const options of broker.options) {
      expect(options).toMatchObject({ failWhenDisconnected: true, budgetSpansConnect: true })
      const { timeoutMs } = options as { timeoutMs: number }
      expect(timeoutMs > 0 && timeoutMs <= 30_000).toBe(true)
    }
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

const FAILED_STAGES = [
  { stage: 'requested', observedAt: 90, observer: 'broker' },
  { stage: 'authorized', observedAt: 91, observer: 'broker' },
  { stage: 'packet-send-failed', observedAt: 92, observer: 'broker', code: 'EHOSTUNREACH' }
]

function wakeAttempt(overrides: Partial<HostCardWakeAttempt> = {}): HostCardWakeAttempt {
  return {
    brokerHostId: 'host-a',
    targetId: TARGET_ID,
    requestId: 'req-00000001',
    pressedAt: 5_000,
    repliedAt: 5_001,
    wakeId: 'wake-1',
    brokerStages: PRESS_STAGES,
    refusalCode: null,
    ...overrides
  }
}

type TargetObservations = Parameters<typeof wakesToRefresh>[1]
const NO_TARGET_ANSWERS: TargetObservations = { statuses: {}, lastConnected: {} }

// Why 6_000 and 6_100: a connection made after the press (5_000), answered after the reply (5_001).
function answeredBy(targetHostId: string): TargetObservations {
  return {
    statuses: { [targetHostId]: { observedAt: 6_100, result: { graphStatus: 'ready' } } },
    lastConnected: { [targetHostId]: 6_000 }
  }
}

describe('wake progress without a timer', () => {
  it('re-reads host.wake.status on the broker client and replaces the broker stages', async () => {
    const broker = fakeSession()
    const before = wakeAttempt({ brokerStages: PRESS_STAGES.slice(0, 2) })

    const done = readHostWakeStatus({ client: broker.client, attempt: before })
    broker.settle(okResponse({ wakeId: 'wake-1', targetId: TARGET_ID, stages: PRESS_STAGES }))
    const after = await done

    expect(broker.calls).toEqual([{ method: 'host.wake.status', params: { wakeId: 'wake-1' } }])
    expect(after).toEqual({ ...before, brokerStages: PRESS_STAGES })
  })

  it('a read the broker no longer knows ends the reads but is never a press refusal (WR-01)', async () => {
    const broker = fakeSession()
    const before = wakeAttempt()

    const done = readHostWakeStatus({ client: broker.client, attempt: before })
    broker.settle(failResponse('wake_unknown'))
    const after = await done

    expect(after).toEqual({ ...before, statusReadCode: 'wake_unknown' })
    expect(after.refusalCode).toBeNull()
    expect(isWakeAttemptTerminal(after)).toBe(true)
  })

  it('a status-read refusal after packet-sent stays a read code, keeping the stages (WR-01)', async () => {
    const broker = fakeSession()
    const before = wakeAttempt()

    const done = readHostWakeStatus({ client: broker.client, attempt: before })
    broker.settle(failResponse('wake_device_revoked'))
    const after = await done

    expect(after).toEqual({ ...before, statusReadCode: 'wake_device_revoked' })
  })

  it('keeps the attempt by identity when the read never answers', async () => {
    const broker = fakeSession()
    const before = wakeAttempt()

    const done = readHostWakeStatus({ client: broker.client, attempt: before })
    broker.settle(new Error('socket closed mid-request'))

    expect(await done).toBe(before)
  })

  it('does not ask without a wakeId', async () => {
    const broker = fakeSession()
    const before = wakeAttempt({ wakeId: null })

    expect(await readHostWakeStatus({ client: broker.client, attempt: before })).toBe(before)
    expect(broker.calls).toEqual([])
  })

  it('ends on a refusal or a failed send, never on a sent packet', () => {
    expect(isWakeAttemptTerminal(wakeAttempt())).toBe(false)
    expect(isWakeAttemptTerminal(wakeAttempt({ brokerStages: 'unreadable' }))).toBe(false)
    expect(isWakeAttemptTerminal(wakeAttempt({ brokerStages: FAILED_STAGES }))).toBe(true)
    const refused = wakeAttempt({ refusalCode: 'wake_grant_missing', brokerStages: null })
    expect(isWakeAttemptTerminal(refused)).toBe(true)
  })

  it('selects for the focus re-read only answered, unfinished wakes with a wakeId', () => {
    const attempts = {
      sent: wakeAttempt(),
      refused: wakeAttempt({ refusalCode: 'wake_send_failed' }),
      failed: wakeAttempt({ brokerStages: FAILED_STAGES }),
      pending: wakeAttempt({ repliedAt: null, wakeId: null, brokerStages: null }),
      unnamed: wakeAttempt({ wakeId: null }),
      readClosed: wakeAttempt({ statusReadCode: 'wake_unknown' })
    }

    expect(wakesToRefresh(attempts, NO_TARGET_ANSWERS)).toEqual([
      { targetHostId: 'sent', attempt: attempts.sent }
    ])
  })

  it('stops re-reading once the target itself answered after the press (WR-01)', () => {
    const attempts = { answered: wakeAttempt(), waiting: wakeAttempt() }

    expect(wakesToRefresh(attempts, answeredBy('answered'))).toEqual([
      { targetHostId: 'waiting', attempt: attempts.waiting }
    ])
  })
})

describe('a wake attempt ends with the boot and the pairing it describes (IN-02)', () => {
  it('ends an attempt whose target answered after the press and is no longer connected', () => {
    const attempts = { 'host-t': wakeAttempt() }
    const observations = {
      ...answeredBy('host-t'),
      hostStates: { 'host-t': 'reconnecting' as const }
    }

    expect(endedWakeAttempts(attempts, observations)).toEqual([
      { targetHostId: 'host-t', requestId: 'req-00000001' }
    ])
  })

  it('keeps it while the target stays connected, and while the target has not answered yet', () => {
    const attempts = { 'host-t': wakeAttempt() }
    const connected = { ...answeredBy('host-t'), hostStates: { 'host-t': 'connected' as const } }
    const asleep = { ...NO_TARGET_ANSWERS, hostStates: { 'host-t': 'reconnecting' as const } }

    expect(endedWakeAttempts(attempts, connected)).toEqual([])
    expect(endedWakeAttempts(attempts, asleep)).toEqual([])
  })

  it('shows an attempt only under the pairing key it was pressed under', () => {
    const attempt = wakeAttempt()
    const otherKey = hostKeyOfPublicKey(OTHER_PUBLIC_KEY)

    expect(
      wakeAttemptForPairing({ attempt, pressedHostKey: VECTOR_HOST_KEY, hostKey: VECTOR_HOST_KEY })
    ).toBe(attempt)
    expect(
      wakeAttemptForPairing({ attempt, pressedHostKey: VECTOR_HOST_KEY, hostKey: otherKey })
    ).toBeNull()
    expect(
      wakeAttemptForPairing({ attempt: undefined, pressedHostKey: null, hostKey: VECTOR_HOST_KEY })
    ).toBeNull()
  })
})

const SESSION_SOURCE = readFileSync(new URL('./home-host-wake-session.ts', import.meta.url), 'utf8')
const HOOK_SOURCE = readFileSync(
  new URL('../components/use-host-card-wake.ts', import.meta.url),
  'utf8'
)
const FORBIDDEN_SESSION_TOKENS = [
  'device-revocation-refusal',
  'namesDeviceRevocation',
  'handleAuthRejection',
  'setInterval',
  'setTimeout',
  'AsyncStorage',
  'async-storage',
  'SecureStore',
  'secure-store',
  'saveHomeSnapshot'
]

describe('a wake refusal stays a wake state', () => {
  it('records wake_device_revoked as the refusal; the latch predicate reads false', async () => {
    const broker = fakeSession()
    const refusal = failResponse('wake_device_revoked', { wakeId: 'wake-1', stages: FAILED_STAGES })

    const done = requestHostWake({
      client: broker.client,
      brokerHostId: 'host-a',
      targetId: TARGET_ID,
      requestId: 'req-00000001',
      now: phoneClock(5_000)
    })
    broker.settle(refusal)
    const attempt = await done

    expect(attempt).toMatchObject({ repliedAt: 5_001, refusalCode: 'wake_device_revoked' })
    expect(isWakeAttemptTerminal(attempt)).toBe(true)
    expect(refusal.ok).toBe(false)
    expect(namesDeviceRevocation(refusal.ok ? null : refusal.error)).toBe(false)
  })

  it('records a refusal without a string code as unknown', async () => {
    const broker = fakeSession()
    const done = requestHostWake({
      client: broker.client,
      brokerHostId: 'host-a',
      targetId: TARGET_ID,
      requestId: 'req-00000001',
      now: phoneClock(5_000)
    })
    broker.settle(failResponse(''))

    expect((await done).refusalCode).toBe('unknown')
  })

  it('the session module and hook never import the latch, never time, never persist', () => {
    for (const source of [SESSION_SOURCE, HOOK_SOURCE]) {
      for (const token of FORBIDDEN_SESSION_TOKENS) {
        expect(source).not.toContain(token)
      }
    }
    // Why: a reader that read nothing would pass the absence rows above.
    expect(SESSION_SOURCE).toContain("'host.wake.request'")
    expect(HOOK_SOURCE).toContain('export function useHostCardWake')
  })
})

class MockWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3

  readonly CONNECTING = MockWebSocket.CONNECTING
  readonly OPEN = MockWebSocket.OPEN
  readonly CLOSING = MockWebSocket.CLOSING
  readonly CLOSED = MockWebSocket.CLOSED

  readyState = MockWebSocket.CONNECTING
  onopen: (() => void) | null = null
  onclose: ((event?: { code?: number; reason?: string; wasClean?: boolean }) => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: (() => void) | null = null
  sent: string[] = []
  close = vi.fn(() => {
    if (this.readyState === MockWebSocket.CLOSED) {
      return
    }
    this.readyState = MockWebSocket.CLOSED
    void Promise.resolve().then(() => this.onclose?.())
  })

  constructor(readonly endpoint: string) {
    mockSockets.push(this)
  }

  send(payload: string): void {
    this.sent.push(payload)
  }

  open(): void {
    this.readyState = MockWebSocket.OPEN
    this.onopen?.()
  }

  receive(payload: unknown): void {
    this.onmessage?.({ data: payload })
  }
}

const mockSockets: MockWebSocket[] = []
const originalWebSocket = globalThis.WebSocket

type WireRequest = { id: string; method: string; params?: unknown }

function readWireRequest(raw: string): WireRequest | null {
  try {
    const parsed: unknown = JSON.parse(raw.replace(/^encrypted:/, ''))
    return typeof parsed === 'object' && parsed !== null && 'method' in parsed
      ? (parsed as WireRequest)
      : null
  } catch {
    return null
  }
}

// Why poll microtasks: the client writes a request after its connect wait resolves.
async function wireRequest(socket: MockWebSocket, method: string): Promise<WireRequest> {
  for (let tick = 0; tick < 50; tick += 1) {
    const found = socket.sent.map(readWireRequest).find((request) => request?.method === method)
    if (found) {
      return found
    }
    await Promise.resolve()
  }
  throw new Error(`no ${method} request reached the socket`)
}

function connectedRealClient() {
  const log: ConnectionLogEntry[] = []
  const states: ConnectionState[] = []
  const client = connect('ws://desktop.invalid', 'token', 'server-key', {
    onLog: (entry) => log.push(entry),
    onStateChange: (state) => states.push(state)
  })
  const socket = mockSockets[0]!
  socket.open()
  socket.receive(JSON.stringify({ type: 'e2ee_ready' }))
  socket.receive('encrypted:{"type":"e2ee_authenticated"}')
  return { client, socket, log, states }
}

function refuseOnWire(socket: MockWebSocket, id: string, error: Record<string, unknown>): void {
  socket.receive(
    `encrypted:${JSON.stringify({ id, ok: false, error, _meta: { runtimeId: 'rt' } })}`
  )
}

describe('a wake refusal through a real RpcClient', () => {
  let authRejections: () => number = () => 0

  afterEach(() => {
    globalThis.WebSocket = originalWebSocket
    vi.restoreAllMocks()
  })

  function arm(): void {
    vi.useFakeTimers()
    mockSockets.length = 0
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket
    // Why console: every handleAuthRejection branch logs '[net] auth rejected'; it is the closure's only seam.
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    authRejections = () =>
      log.mock.calls.filter((call) => String(call[0]).startsWith('[net] auth rejected')).length
  }

  it('never reaches handleAuthRejection and leaves the pairing connected', async () => {
    arm()
    const { client, socket, log, states } = connectedRealClient()
    expect(client.getState()).toBe('connected')

    const done = requestHostWake({
      client,
      brokerHostId: 'host-a',
      targetId: TARGET_ID,
      requestId: 'req-00000001',
      now: phoneClock(5_000)
    })
    const request = await wireRequest(socket, 'host.wake.request')
    refuseOnWire(socket, request.id, {
      code: 'wake_device_revoked',
      message: 'This device is revoked for wake.',
      data: { wakeId: 'wake-1', stages: FAILED_STAGES }
    })
    const attempt = await done

    expect(attempt.refusalCode).toBe('wake_device_revoked')
    expect(authRejections()).toBe(0)
    expect(log.map((entry) => entry.message)).not.toContain('Authentication rejected')
    expect(states).not.toContain('reconnecting')
    expect(states).not.toContain('auth-failed')
    expect(client.getState()).toBe('connected')
    expect(socket.close).not.toHaveBeenCalled()
    expect(mockSockets).toHaveLength(1)
    // Why: the same pairing still carries and answers the next request.
    const next = client.sendRequest('status.get')
    const nextRequest = await wireRequest(socket, 'status.get')
    socket.receive(
      `encrypted:${JSON.stringify({ id: nextRequest.id, ok: true, result: {}, _meta: { runtimeId: 'rt' } })}`
    )
    expect((await next).ok).toBe(true)

    client.close()
  })

  it('control: an unauthorized device_revoked reply on the same path does reach it', async () => {
    arm()
    const { client, socket } = connectedRealClient()

    const done = requestHostWake({
      client,
      brokerHostId: 'host-a',
      targetId: TARGET_ID,
      requestId: 'req-00000001',
      now: phoneClock(5_000)
    })
    const request = await wireRequest(socket, 'host.wake.request')
    refuseOnWire(socket, request.id, {
      code: 'unauthorized',
      message: 'Device access revoked',
      data: { reason: 'device_revoked' }
    })
    const attempt = await done

    expect(authRejections()).toBeGreaterThan(0)
    expect(client.getState()).toBe('auth-failed')
    expect(attempt.refusalCode).toBe('unknown')

    client.close()
  })

  it('a press on a disconnected client settles now as unknown and never sends after reconnect (WR-02)', async () => {
    arm()
    const client = connect('ws://desktop.invalid', 'token', 'server-key', {})
    const socket = mockSockets[0]!
    expect(client.getState()).not.toBe('connected')

    const attempt = await requestHostWake({
      client,
      brokerHostId: 'host-a',
      targetId: TARGET_ID,
      requestId: 'req-00000001',
      now: phoneClock(5_000)
    })
    socket.open()
    socket.receive(JSON.stringify({ type: 'e2ee_ready' }))
    socket.receive('encrypted:{"type":"e2ee_authenticated"}')
    for (let tick = 0; tick < 50; tick += 1) {
      await Promise.resolve()
    }

    expect(attempt).toMatchObject({ repliedAt: 5_001, wakeId: null, refusalCode: 'unknown' })
    expect(client.getState()).toBe('connected')
    const wakeSends = socket.sent
      .map(readWireRequest)
      .filter((r) => r?.method === 'host.wake.request')
    expect(wakeSends).toEqual([])

    client.close()
  })
})
