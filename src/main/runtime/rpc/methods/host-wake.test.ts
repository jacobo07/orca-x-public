import { afterEach, describe, expect, it } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { isStreamingMethod, type RpcContext, type RpcFailure } from '../core'
import { mapRuntimeError } from '../errors'
import { RUNTIME_CAPABILITIES } from '../../../../shared/protocol-version'
import {
  createWakeBroker,
  type WakeBrokerStoreView,
  type WakeDeviceAuthority,
  type WakeTarget
} from '../../wake-broker'
import { wakeBrokerHost, wakeBrokerRuntimeCapabilities } from '../../wake-broker-host'
import { fingerprintHostKeyBytes } from '../../host-key-fingerprint'
import { HOST_WAKE_METHODS } from './host-wake'

const MAC_PATTERN = /([0-9a-f]{2}[:-]){5}[0-9a-f]{2}/i
const HOST_KEY = fingerprintHostKeyBytes(Buffer.alloc(32, 2))
const T1: WakeTarget = {
  targetId: 'wt_0000000000a1',
  mac: 'aa:bb:cc:dd:ee:01',
  broadcast: '192.168.1.255',
  port: 9,
  label: 'Desk PC',
  createdAt: 1
}
const T2: WakeTarget = {
  targetId: 'wt_0000000000b2',
  mac: 'aa:bb:cc:dd:ee:02',
  broadcast: '192.168.1.255',
  port: 7,
  label: 'NAS',
  createdAt: 2,
  hostKey: HOST_KEY
}
const REMOVED_TARGET_ID = 'wt_0000000000c3'

type Sent = { frame: Buffer; address: string; port: number }
type Outcome = { ok: true; result: unknown } | { ok: false; error: RpcFailure['error'] }

const sent: Sent[] = []
const phoneResults: unknown[] = []
const clock = 1_760_000_000_000
let wakeCounter = 0

function memoryStore(
  targets: WakeTarget[],
  grants: readonly [string, string][]
): WakeBrokerStoreView {
  const grantKeys = new Set(grants.map(([deviceId, targetId]) => `${deviceId}\u0000${targetId}`))
  return {
    targets: () => targets.slice(),
    target: (targetId) => targets.find((t) => t.targetId === targetId) ?? null,
    hasGrant: (deviceId, targetId) => grantKeys.has(`${deviceId}\u0000${targetId}`)
  }
}

function fakeAuthority(): WakeDeviceAuthority {
  const tokens: Record<string, string> = { 'tok-a': 'dev-a', 'tok-b': 'dev-b', 'tok-c': 'dev-c' }
  return {
    authorize: (token) => {
      if (token === 'tok-revoked') {
        return { ok: false, reason: 'device_revoked' }
      }
      const deviceId = tokens[token]
      return deviceId ? { ok: true, deviceId } : { ok: false, reason: 'unknown_token' }
    },
    deviceState: (deviceId) => (Object.values(tokens).includes(deviceId) ? 'present' : 'absent')
  }
}

function enableBroker(options: { attachAuthority?: boolean } = {}): void {
  const store = memoryStore(
    [T1, T2],
    [
      ['dev-a', T1.targetId],
      ['dev-a', REMOVED_TARGET_ID],
      ['dev-b', T2.targetId]
    ]
  )
  const broker = createWakeBroker({
    now: () => clock,
    store,
    authority: () => wakeBrokerHost.authority(),
    sendMagicPacket: async (frame, address, port) => {
      sent.push({ frame, address, port })
    },
    newWakeId: () => `wk_test_${++wakeCounter}`
  })
  wakeBrokerHost.enable({ broker, store })
  if (options.attachAuthority !== false) {
    wakeBrokerHost.attachDeviceAuthority(fakeAuthority())
  }
}

function deviceCtx(token: string, deviceId: string): RpcContext {
  return {
    runtime: {} as OrcaRuntimeService,
    clientId: token,
    pairedDeviceId: deviceId,
    clientKind: 'mobile'
  }
}

async function call(name: string, params: unknown, ctx: RpcContext): Promise<Outcome> {
  const method = HOST_WAKE_METHODS.find((m) => m.name === name)
  if (!method || isStreamingMethod(method)) {
    throw new Error(`${name} must be a request method`)
  }
  try {
    const parsed = method.params ? method.params.parse(params) : params
    const result = await method.handler(parsed, ctx)
    phoneResults.push(result)
    return { ok: true, result }
  } catch (error) {
    return { ok: false, error: mapRuntimeError('req-1', { runtimeId: 'broker-1' }, error).error }
  }
}

async function expectRefusal(outcome: Promise<Outcome>, code: string): Promise<void> {
  const settled = await outcome
  expect(settled.ok).toBe(false)
  if (settled.ok) {
    return
  }
  expect(settled.error.code).toBe(code)
  // Why: the phone latches revocation on reason/data.reason === 'device_revoked'; a wake refusal must never trip it.
  expect(JSON.stringify(settled.error.data ?? null)).not.toContain('device_revoked')
}

const REQUEST = { targetId: T1.targetId, requestId: 'req-00000001' }

describe('host.wake.* phone methods', () => {
  afterEach(() => {
    expect(JSON.stringify(phoneResults)).not.toMatch(MAC_PATTERN)
    wakeBrokerHost.disable()
    wakeBrokerHost.attachDeviceAuthority(null)
    sent.length = 0
    phoneResults.length = 0
  })

  it('refuses with wake_broker_disabled on every method when no broker is enabled', async () => {
    const ctx = deviceCtx('tok-a', 'dev-a')
    await expectRefusal(call('host.wake.request', REQUEST, ctx), 'wake_broker_disabled')
    await expectRefusal(call('host.wake.targets', null, ctx), 'wake_broker_disabled')
    await expectRefusal(call('host.wake.status', { wakeId: 'wk_1' }, ctx), 'wake_broker_disabled')
    expect(sent).toHaveLength(0)
  })

  it('refuses with wake_broker_unavailable when the broker failed to start', async () => {
    wakeBrokerHost.markUnavailable('wake_broker_state_unreadable')
    await expectRefusal(
      call('host.wake.request', REQUEST, deviceCtx('tok-a', 'dev-a')),
      'wake_broker_unavailable'
    )
    expect(sent).toHaveLength(0)
  })

  it('refuses with wake_broker_unavailable while no device authority is attached', async () => {
    enableBroker({ attachAuthority: false })
    await expectRefusal(
      call('host.wake.request', REQUEST, deviceCtx('tok-a', 'dev-a')),
      'wake_broker_unavailable'
    )
    expect(sent).toHaveLength(0)
  })

  it('refuses a local caller with wake_device_required', async () => {
    enableBroker()
    await expectRefusal(
      call('host.wake.request', REQUEST, { runtime: {} as OrcaRuntimeService }),
      'wake_device_required'
    )
    expect(sent).toHaveLength(0)
  })

  it('refuses a revoked device with wake_device_revoked, never the latch reason', async () => {
    enableBroker()
    await expectRefusal(
      call('host.wake.request', REQUEST, deviceCtx('tok-revoked', 'dev-a')),
      'wake_device_revoked'
    )
    expect(sent).toHaveLength(0)
  })

  it('refuses an unknown token and a token for another device with wake_device_unauthorized', async () => {
    enableBroker()
    await expectRefusal(
      call('host.wake.request', REQUEST, deviceCtx('tok-unknown', 'dev-a')),
      'wake_device_unauthorized'
    )
    await expectRefusal(
      call('host.wake.request', REQUEST, deviceCtx('tok-b', 'dev-a')),
      'wake_device_unauthorized'
    )
    expect(sent).toHaveLength(0)
  })

  it('refuses an ungranted device with wake_grant_missing for registered and unregistered ids alike', async () => {
    enableBroker()
    const ctx = deviceCtx('tok-c', 'dev-c')
    await expectRefusal(call('host.wake.request', REQUEST, ctx), 'wake_grant_missing')
    await expectRefusal(
      call('host.wake.request', { targetId: 'wt_ffffffffffff', requestId: 'req-00000002' }, ctx),
      'wake_grant_missing'
    )
    expect(sent).toHaveLength(0)
  })

  it('refuses a granted target that is no longer registered with wake_target_unknown', async () => {
    enableBroker()
    await expectRefusal(
      call(
        'host.wake.request',
        { targetId: REMOVED_TARGET_ID, requestId: 'req-00000003' },
        deviceCtx('tok-a', 'dev-a')
      ),
      'wake_target_unknown'
    )
    expect(sent).toHaveLength(0)
  })

  it('sends exactly one 102-byte frame for a granted device and returns the three broker stages', async () => {
    enableBroker()
    const outcome = await call('host.wake.request', REQUEST, deviceCtx('tok-a', 'dev-a'))
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) {
      return
    }
    const result = outcome.result as {
      wakeId: string
      targetId: string
      replayed: boolean
      adopted: boolean
      stages: { stage: string; observedAt: number; observer: string }[]
    }
    expect(result).toMatchObject({ targetId: T1.targetId, replayed: false, adopted: false })
    expect(result.wakeId).toEqual(expect.any(String))
    expect(result.stages.map((s) => s.stage)).toEqual(['requested', 'authorized', 'packet-sent'])
    expect(result.stages.every((s) => s.observer === 'broker')).toBe(true)
    const times = result.stages.map((s) => s.observedAt)
    expect(times).toEqual([...times].sort((a, b) => a - b))
    expect(sent).toHaveLength(1)
    expect(sent[0].frame.length).toBe(102)
    expect(sent[0].address).toBe(T1.broadcast)
    expect(sent[0].port).toBe(T1.port)

    const status = await call(
      'host.wake.status',
      { wakeId: result.wakeId },
      deviceCtx('tok-a', 'dev-a')
    )
    expect(status.ok && (status.result as { stages: unknown[] }).stages).toEqual(result.stages)
  })

  it('lists only the targets the calling device holds a grant for, as id, label and a bound hostKey', async () => {
    enableBroker()
    const outcome = await call('host.wake.targets', null, deviceCtx('tok-a', 'dev-a'))
    expect(outcome.ok && outcome.result).toEqual({
      targets: [{ targetId: T1.targetId, label: T1.label }]
    })
    const other = await call('host.wake.targets', null, deviceCtx('tok-b', 'dev-b'))
    expect(other.ok && other.result).toEqual({
      targets: [{ targetId: T2.targetId, label: T2.label, hostKey: HOST_KEY }]
    })
  })

  it('projects exactly targetId, label and a bound hostKey: never mac, broadcast or port', async () => {
    enableBroker()
    const keysOf = async (token: string, deviceId: string): Promise<string[][]> => {
      const outcome = await call('host.wake.targets', null, deviceCtx(token, deviceId))
      const { targets } = (outcome.ok ? outcome.result : { targets: [] }) as {
        targets: Record<string, unknown>[]
      }
      return targets.map((target) => Object.keys(target).sort())
    }
    expect(await keysOf('tok-a', 'dev-a')).toEqual([['label', 'targetId']])
    expect(await keysOf('tok-b', 'dev-b')).toEqual([['hostKey', 'label', 'targetId']])
  })

  it('advertises host.wake-broker.v1 only while a broker is enabled, never statically', () => {
    expect(wakeBrokerRuntimeCapabilities()).toEqual([])
    enableBroker()
    expect(wakeBrokerRuntimeCapabilities()).toEqual(['host.wake-broker.v1'])
    wakeBrokerHost.disable()
    expect(wakeBrokerRuntimeCapabilities()).toEqual([])
    expect(RUNTIME_CAPABILITIES as readonly string[]).not.toContain('host.wake-broker.v1')
  })
})
