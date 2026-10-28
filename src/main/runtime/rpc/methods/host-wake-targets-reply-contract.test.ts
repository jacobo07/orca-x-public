import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { isStreamingMethod, type RpcContext } from '../core'
import {
  createWakeBroker,
  type WakeBrokerStoreView,
  type WakeDeviceAuthority,
  type WakeTarget
} from '../../wake-broker'
import { wakeBrokerHost } from '../../wake-broker-host'
import { fingerprintHostKeyBytes } from '../../host-key-fingerprint'
import {
  composeHostWakeRoute,
  hostKeyFromPublicKeyB64,
  parseHostWakeTargetsReply,
  type WakeRouteBroker
} from '../../../../shared/host-wake-proxy'
import { HOST_WAKE_BROKER_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { HOST_WAKE_METHODS } from './host-wake'

// Contract: the phone's parser reads what the broker's real host.wake.targets handler returns (CR-01).
const CARD_PUBLIC_KEY = Buffer.alloc(32, 7).toString('base64')
const CARD_HOST_KEY = hostKeyFromPublicKeyB64(CARD_PUBLIC_KEY, (bytes) =>
  createHash('sha256').update(bytes).digest()
)
const BOUND: WakeTarget = {
  targetId: 'wt_00000000c0de',
  mac: 'aa:bb:cc:dd:ee:07',
  broadcast: '192.168.1.255',
  port: 9,
  label: 'Studio',
  createdAt: 1,
  hostKey: fingerprintHostKeyBytes(Buffer.from(CARD_PUBLIC_KEY, 'base64'))
}
const UNBOUND: WakeTarget = {
  targetId: 'wt_00000000f00d',
  mac: 'aa:bb:cc:dd:ee:08',
  broadcast: '192.168.1.255',
  port: 9,
  label: 'NAS',
  createdAt: 2
}
const PHONE_CTX: RpcContext = {
  runtime: {} as OrcaRuntimeService,
  clientId: 'tok-phone',
  pairedDeviceId: 'dev-phone',
  clientKind: 'mobile'
}
const SESSION_SOURCE = readFileSync(
  new URL('../../../../../mobile/src/transport/home-host-wake-session.ts', import.meta.url),
  'utf8'
)

function enableRealBroker(): void {
  const targets = [BOUND, UNBOUND]
  const store: WakeBrokerStoreView = {
    targets: () => targets.slice(),
    target: (targetId) => targets.find((t) => t.targetId === targetId) ?? null,
    hasGrant: (deviceId) => deviceId === 'dev-phone'
  }
  const authority: WakeDeviceAuthority = {
    authorize: (token) =>
      token === 'tok-phone'
        ? { ok: true, deviceId: 'dev-phone' }
        : { ok: false, reason: 'unknown_token' },
    deviceState: () => 'present'
  }
  const broker = createWakeBroker({
    now: () => 1_760_000_000_000,
    store,
    authority: () => wakeBrokerHost.authority(),
    // Why no packet: this contract reads targets only.
    sendMagicPacket: () => Promise.resolve(),
    newWakeId: () => 'wk_contract'
  })
  wakeBrokerHost.enable({ broker, store })
  wakeBrokerHost.attachDeviceAuthority(authority)
}

async function realTargetsReply(): Promise<unknown> {
  const method = HOST_WAKE_METHODS.find((m) => m.name === 'host.wake.targets')
  if (!method || isStreamingMethod(method)) {
    throw new Error('host.wake.targets must be a request method')
  }
  return method.handler(method.params ? method.params.parse(null) : null, PHONE_CTX)
}

function brokerAnswering(targets: unknown): WakeRouteBroker {
  return {
    brokerHostId: 'host-broker',
    inputs: {
      broker: { connected: true, lastConnectedAt: 1_000 },
      status: {
        observedAt: 1_001,
        result: { capabilities: [HOST_WAKE_BROKER_RUNTIME_CAPABILITY] }
      },
      targets: { observedAt: 1_002, targets }
    }
  }
}

describe('host.wake.targets reply contract (broker answer -> phone parser -> route)', () => {
  afterEach(() => {
    wakeBrokerHost.disable()
  })

  it('the parser unwraps the real handler answer and the bound card routes to its target', async () => {
    enableRealBroker()
    const reply = await realTargetsReply()

    const route = composeHostWakeRoute({
      targetHostId: 'host-card',
      hostKey: CARD_HOST_KEY,
      brokers: [brokerAnswering(parseHostWakeTargetsReply(reply))]
    })

    expect(CARD_HOST_KEY).toBe(BOUND.hostKey)
    expect(route).toMatchObject({
      send: true,
      brokerHostId: 'host-broker',
      targetId: BOUND.targetId
    })
  })

  it('control: the same answer stored raw (the CR-01 shape) routes nothing', async () => {
    enableRealBroker()
    const reply = await realTargetsReply()

    expect(
      composeHostWakeRoute({
        targetHostId: 'host-card',
        hostKey: CARD_HOST_KEY,
        brokers: [brokerAnswering(reply)]
      })
    ).toEqual({ send: false, reason: 'no_bound_target' })
  })

  it('reads only a record carrying a targets array', () => {
    expect(parseHostWakeTargetsReply({ targets: [] })).toEqual([])
    expect(parseHostWakeTargetsReply([{ targetId: BOUND.targetId, label: 'Studio' }])).toBeNull()
    expect(parseHostWakeTargetsReply({ targets: 'wt_00000000c0de' })).toBeNull()
    expect(parseHostWakeTargetsReply({})).toBeNull()
    expect(parseHostWakeTargetsReply(null)).toBeNull()
  })

  it('the phone session stores the host.wake.targets answer only through the parser', () => {
    expect(SESSION_SOURCE.split('parseHostWakeTargetsReply(response.result)')).toHaveLength(2)
    expect(SESSION_SOURCE).not.toMatch(/targets:\s*response\.result\b/)
  })
})
