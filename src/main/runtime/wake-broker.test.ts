import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { HostWakeStageRecord } from '../../shared/host-wake'
import {
  createWakeBroker,
  WAKE_ADOPT_WINDOW_MS,
  WAKE_BURST_COUNT,
  WAKE_DEDUPE_WINDOW_MS,
  WAKE_RECORD_CAP,
  type WakeBroker,
  type WakeBrokerStoreView,
  type WakeDeviceAuthority,
  type WakeTarget
} from './wake-broker'

const START = 1_760_000_000_000
const RETENTION_MS = 300_000

function target(index: number): WakeTarget {
  const hex = index.toString(16).padStart(12, '0')
  return {
    targetId: `wt_${hex}`,
    mac: `aa:bb:cc:${hex.slice(6, 8)}:${hex.slice(8, 10)}:${hex.slice(10, 12)}`,
    broadcast: '127.0.0.1',
    port: 9,
    label: `Target ${index}`,
    createdAt: START
  }
}

const T1 = target(1)
const T2 = target(2)
const BULK = Array.from({ length: WAKE_RECORD_CAP + 1 }, (_, i) => target(100 + i))

type Harness = {
  broker: WakeBroker
  sends: { frame: Buffer; address: string; port: number }[]
  revoked: Set<string>
  advance(ms: number): void
}

const everyStage: HostWakeStageRecord[] = []

function harness(
  options: {
    send?: () => Promise<void>
    authorize?: WakeDeviceAuthority['authorize']
  } = {}
): Harness {
  let now = START
  let ids = 0
  const sends: Harness['sends'] = []
  const revoked = new Set<string>()
  const tokens: Record<string, string> = { 'tok-a': 'dev-a', 'tok-b': 'dev-b', 'tok-c': 'dev-c' }
  const grants = new Set([
    `dev-a\u0000${T1.targetId}`,
    `dev-a\u0000${T2.targetId}`,
    `dev-b\u0000${T1.targetId}`,
    ...BULK.map((t) => `dev-a\u0000${t.targetId}`)
  ])
  const targets = [T1, T2, ...BULK]
  const store: WakeBrokerStoreView = {
    targets: () => targets.slice(),
    target: (id) => targets.find((t) => t.targetId === id) ?? null,
    hasGrant: (deviceId, targetId) => grants.has(`${deviceId}\u0000${targetId}`)
  }
  const authority: WakeDeviceAuthority = {
    authorize:
      options.authorize ??
      ((token) => {
        if (revoked.has(token)) {
          return { ok: false, reason: 'device_revoked' }
        }
        return tokens[token]
          ? { ok: true, deviceId: tokens[token] }
          : { ok: false, reason: 'unknown_token' }
      }),
    deviceExists: (deviceId) => Object.values(tokens).includes(deviceId)
  }
  const broker = createWakeBroker({
    now: () => now,
    store,
    authority: () => authority,
    sendMagicPacket: async (frame, address, port) => {
      sends.push({ frame, address, port })
      if (options.send) {
        await options.send()
      }
    },
    newWakeId: () => `wk_${++ids}`
  })
  return {
    broker: {
      request: async (args) => {
        const result = await broker.request(args)
        everyStage.push(...result.stages)
        return result
      },
      status: (args) => {
        const result = broker.status(args)
        everyStage.push(...result.stages)
        return result
      },
      targetsFor: (args) => broker.targetsFor(args)
    },
    sends,
    revoked,
    advance: (ms) => {
      now += ms
    }
  }
}

const A = { token: 'tok-a', deviceId: 'dev-a' }
const B = { token: 'tok-b', deviceId: 'dev-b' }
const C = { token: 'tok-c', deviceId: 'dev-c' }

async function refusalCode(run: () => unknown): Promise<{ code: string; data?: unknown }> {
  try {
    await run()
  } catch (error) {
    const { code, data } = error as { code: string; data?: unknown }
    return { code, data }
  }
  throw new Error('expected a refusal')
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {}
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe('wake broker', () => {
  let h: Harness

  beforeEach(() => {
    h = harness()
  })

  afterAll(() => {
    expect(everyStage.length).toBeGreaterThan(0)
    const brokerClaims = everyStage.filter(
      (s) => s.stage === 'host-announced' || s.stage === 'runtime-ready'
    )
    expect(brokerClaims).toEqual([])
  })

  it('names one frame per accepted wake and the D-09 windows', () => {
    expect(WAKE_BURST_COUNT).toBe(1)
    expect(WAKE_DEDUPE_WINDOW_MS).toBe(60_000)
    expect(WAKE_ADOPT_WINDOW_MS).toBe(10_000)
    expect(WAKE_RECORD_CAP).toBe(256)
  })

  it('replays the same (target, requestId) within 60 s and sends again after it', async () => {
    const first = await h.broker.request({ ...A, targetId: T1.targetId, requestId: 'req-dup-1' })
    h.advance(WAKE_DEDUPE_WINDOW_MS)
    const replay = await h.broker.request({ ...A, targetId: T1.targetId, requestId: 'req-dup-1' })
    expect(replay).toEqual({ ...first, replayed: true })
    expect(h.sends).toHaveLength(1)
    h.advance(1)
    const fresh = await h.broker.request({ ...A, targetId: T1.targetId, requestId: 'req-dup-1' })
    expect(fresh.wakeId).not.toBe(first.wakeId)
    expect(fresh.replayed).toBe(false)
    expect(h.sends).toHaveLength(2)
  })

  it('joins concurrent duplicates to one in-flight send', async () => {
    const gate = deferred()
    h = harness({ send: () => gate.promise })
    const one = h.broker.request({ ...A, targetId: T1.targetId, requestId: 'req-conc-1' })
    const two = h.broker.request({ ...A, targetId: T1.targetId, requestId: 'req-conc-1' })
    expect(h.sends).toHaveLength(1)
    gate.resolve()
    const [first, second] = await Promise.all([one, two])
    expect(second.wakeId).toBe(first.wakeId)
    expect(second.replayed).toBe(true)
    expect(h.sends).toHaveLength(1)
  })

  it('adopts the in-flight wake for a different requestId within 10 s, keyed by target', async () => {
    const first = await h.broker.request({ ...A, targetId: T1.targetId, requestId: 'req-adopt-1' })
    h.advance(5_000)
    const sameDevice = await h.broker.request({
      ...A,
      targetId: T1.targetId,
      requestId: 'req-adopt-2'
    })
    const otherDevice = await h.broker.request({
      ...B,
      targetId: T1.targetId,
      requestId: 'req-adopt-3'
    })
    expect(sameDevice).toMatchObject({ wakeId: first.wakeId, adopted: true, replayed: false })
    expect(otherDevice).toMatchObject({ wakeId: first.wakeId, adopted: true })
    expect(h.sends).toHaveLength(1)
    const otherTarget = await h.broker.request({
      ...A,
      targetId: T2.targetId,
      requestId: 'req-adopt-4'
    })
    expect(otherTarget.adopted).toBe(false)
    expect(otherTarget.wakeId).not.toBe(first.wakeId)
    expect(h.sends).toHaveLength(2)
    h.advance(WAKE_ADOPT_WINDOW_MS - 5_000 + 1)
    const later = await h.broker.request({ ...A, targetId: T1.targetId, requestId: 'req-adopt-5' })
    expect(later.adopted).toBe(false)
    expect(h.sends).toHaveLength(3)
  })

  it('runs authority before dedupe: no replay to a revoked or ungranted device', async () => {
    await h.broker.request({ ...A, targetId: T1.targetId, requestId: 'req-auth-1' })
    const ungranted = await refusalCode(() =>
      h.broker.request({ ...C, targetId: T1.targetId, requestId: 'req-auth-1' })
    )
    expect(ungranted.code).toBe('wake_grant_missing')
    h.revoked.add('tok-a')
    const revoked = await refusalCode(() =>
      h.broker.request({ ...A, targetId: T1.targetId, requestId: 'req-auth-1' })
    )
    expect(revoked.code).toBe('wake_device_revoked')
    expect(h.sends).toHaveLength(1)
  })

  it('refuses a device revoked between authorization and the send, sending nothing', async () => {
    let calls = 0
    h = harness({
      authorize: () =>
        ++calls === 1 ? { ok: true, deviceId: 'dev-a' } : { ok: false, reason: 'device_revoked' }
    })
    const refusal = await refusalCode(() =>
      h.broker.request({ ...A, targetId: T1.targetId, requestId: 'req-between' })
    )
    expect(refusal.code).toBe('wake_device_revoked')
    expect(calls).toBe(2)
    expect(h.sends).toHaveLength(0)
    const stages = (refusal.data as { stages: HostWakeStageRecord[] }).stages
    everyStage.push(...stages)
    expect(stages.map((s) => s.stage)).toEqual(['requested', 'authorized'])
  })

  it('records packet-send-failed with the error code and refuses with wake_send_failed', async () => {
    h = harness({
      send: () => Promise.reject(Object.assign(new Error('unreachable'), { code: 'EHOSTUNREACH' }))
    })
    const refusal = await refusalCode(() =>
      h.broker.request({ ...A, targetId: T1.targetId, requestId: 'req-fail-1' })
    )
    expect(refusal.code).toBe('wake_send_failed')
    const { wakeId } = refusal.data as { wakeId: string }
    const status = h.broker.status({ ...A, wakeId })
    expect(status.stages.map((s) => s.stage)).toEqual([
      'requested',
      'authorized',
      'packet-send-failed'
    ])
    expect(status.stages.at(-1)?.code).toBe('EHOSTUNREACH')
  })

  it('answers status for a granted wake and wake_unknown for unknown, other-target and expired ids', async () => {
    const wake = await h.broker.request({ ...A, targetId: T2.targetId, requestId: 'req-stat-1' })
    expect(h.broker.status({ ...A, wakeId: wake.wakeId }).stages).toEqual(wake.stages)
    expect((await refusalCode(() => h.broker.status({ ...A, wakeId: 'wk_none' }))).code).toBe(
      'wake_unknown'
    )
    expect((await refusalCode(() => h.broker.status({ ...B, wakeId: wake.wakeId }))).code).toBe(
      'wake_unknown'
    )
    h.advance(RETENTION_MS + 1)
    expect((await refusalCode(() => h.broker.status({ ...A, wakeId: wake.wakeId }))).code).toBe(
      'wake_unknown'
    )
  })

  it('caps records at WAKE_RECORD_CAP, evicting the oldest', async () => {
    const wakes = []
    for (const [i, t] of BULK.entries()) {
      wakes.push(await h.broker.request({ ...A, targetId: t.targetId, requestId: `req-cap-${i}` }))
    }
    expect(h.sends).toHaveLength(BULK.length)
    const oldest = await refusalCode(() => h.broker.status({ ...A, wakeId: wakes[0].wakeId }))
    expect(oldest.code).toBe('wake_unknown')
    expect(h.broker.status({ ...A, wakeId: wakes.at(-1)!.wakeId }).wakeId).toBe(
      wakes.at(-1)!.wakeId
    )
  })
})
