import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { isStreamingMethod, type RpcContext, type RpcFailure } from '../core'
import { mapRuntimeError } from '../errors'
import { startWakeBroker, wakeBrokerHost } from '../../wake-broker-host'
import { loadWakeBrokerStore } from '../../wake-broker-store'
import { wakeDeviceState, type WakeDeviceAuthority } from '../../wake-broker'
import { HOST_WAKE_ADMIN_METHODS } from './host-wake-admin'
import { HOST_WAKE_METHODS } from './host-wake'

type Outcome = { ok: true; result: unknown } | { ok: false; error: RpcFailure['error'] }

const LOCAL: RpcContext = { runtime: {} as OrcaRuntimeService }
const REMOTE_CONTEXTS: [string, RpcContext][] = [
  ['clientId', { ...LOCAL, clientId: 'tok-a' }],
  ['pairedDeviceId', { ...LOCAL, pairedDeviceId: 'dev-a' }],
  ['clientKind runtime', { ...LOCAL, clientKind: 'runtime' }],
  ['connectionId', { ...LOCAL, connectionId: 'conn-1' }]
]

let userData = ''

function method(name: string) {
  const found = HOST_WAKE_ADMIN_METHODS.find((m) => m.name === name)
  if (!found || isStreamingMethod(found)) {
    throw new Error(`${name} must be a request method`)
  }
  return found
}

async function call(name: string, params: unknown, ctx: RpcContext = LOCAL): Promise<Outcome> {
  const found = method(name)
  try {
    const parsed = found.params ? found.params.parse(params) : params
    return { ok: true, result: await found.handler(parsed, ctx) }
  } catch (error) {
    return { ok: false, error: mapRuntimeError('req-1', { runtimeId: 'broker-1' }, error).error }
  }
}

function refusalCode(outcome: Outcome): string | null {
  return outcome.ok ? null : outcome.error.code
}

function persistedTargetCount(): number {
  const loaded = loadWakeBrokerStore(userData)
  if (!loaded.ok) {
    throw new Error(loaded.reason)
  }
  return loaded.store.targets().length
}

describe('host.wake.admin target add and list', () => {
  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'orca-wake-admin-'))
  })

  afterEach(() => {
    wakeBrokerHost.disable()
    wakeBrokerHost.attachDeviceAuthority(null)
    rmSync(userData, { recursive: true, force: true })
  })

  it('registers a target for a local caller and lists it', async () => {
    startWakeBroker(userData, { sendMagicPacket: async () => {} })
    const added = await call('host.wake.admin.targetAdd', {
      mac: 'AA-BB-CC-DD-EE-FF',
      label: 'desk'
    })
    expect(added.ok).toBe(true)
    const target = (added as { result: { target: Record<string, unknown> } }).result.target
    expect(target).toEqual({
      targetId: expect.stringMatching(/^wt_[0-9a-f]{12}$/),
      mac: 'aa:bb:cc:dd:ee:ff',
      broadcast: '255.255.255.255',
      port: 9,
      label: 'desk',
      createdAt: expect.any(Number)
    })
    const listed = await call('host.wake.admin.targetList', null)
    expect(listed.ok && listed.result).toEqual({ targets: [target] })
    expect(persistedTargetCount()).toBe(1)
  })

  it('mints ids that do not derive from the MAC', async () => {
    startWakeBroker(userData, { sendMagicPacket: async () => {} })
    const first = await call('host.wake.admin.targetAdd', { mac: 'aa:bb:cc:dd:ee:ff' })
    const second = await call('host.wake.admin.targetAdd', { mac: 'aa:bb:cc:dd:ee:ff' })
    const ids = [first, second].map(
      (outcome) => (outcome as { result: { target: { targetId: string } } }).result.target.targetId
    )
    expect(ids[0]).not.toBe(ids[1])
    for (const id of ids) {
      expect(id).not.toContain('aabbcc')
      expect(id).not.toContain('ddeeff')
    }
  })

  it.each(REMOTE_CONTEXTS)(
    'refuses a non-local caller (%s) with remote_caller_refused and writes nothing',
    async (_label, ctx) => {
      startWakeBroker(userData, { sendMagicPacket: async () => {} })
      expect(
        refusalCode(await call('host.wake.admin.targetAdd', { mac: 'aa:bb:cc:dd:ee:ff' }, ctx))
      ).toBe('remote_caller_refused')
      expect(refusalCode(await call('host.wake.admin.targetList', null, ctx))).toBe(
        'remote_caller_refused'
      )
      expect(wakeBrokerHost.current()?.store.targets()).toEqual([])
      expect(persistedTargetCount()).toBe(0)
    }
  )

  it('refuses with wake_broker_disabled when no broker runs', async () => {
    expect(refusalCode(await call('host.wake.admin.targetList', null))).toBe('wake_broker_disabled')
    expect(refusalCode(await call('host.wake.admin.targetAdd', { mac: 'aa:bb:cc:dd:ee:ff' }))).toBe(
      'wake_broker_disabled'
    )
  })

  it('refuses with wake_broker_unavailable when the broker could not start', async () => {
    wakeBrokerHost.markUnavailable('wake_broker_state_unreadable')
    expect(refusalCode(await call('host.wake.admin.targetList', null))).toBe(
      'wake_broker_unavailable'
    )
  })

  it.each([
    ['a 5-octet MAC', { mac: 'aa:bb:cc:dd:ee' }],
    ['a non-hex MAC', { mac: 'aa:bb:cc:dd:ee:gg' }],
    ['a hostname broadcast', { mac: 'aa:bb:cc:dd:ee:ff', broadcast: 'example.com' }],
    ['an IPv6 broadcast', { mac: 'aa:bb:cc:dd:ee:ff', broadcast: '::1' }],
    ['port 0', { mac: 'aa:bb:cc:dd:ee:ff', port: 0 }],
    ['port 65536', { mac: 'aa:bb:cc:dd:ee:ff', port: 65_536 }],
    ['a 65-character label', { mac: 'aa:bb:cc:dd:ee:ff', label: 'x'.repeat(65) }],
    ['a label with a control character', { mac: 'aa:bb:cc:dd:ee:ff', label: 'desk\u0000nas' }]
  ])('rejects %s as invalid params', (_label, params) => {
    const schema = method('host.wake.admin.targetAdd').params
    expect(schema?.safeParse(params).success).toBe(false)
  })

  it('accepts a subnet broadcast, a port and a 64-character label', () => {
    const schema = method('host.wake.admin.targetAdd').params
    expect(
      schema?.safeParse({
        mac: 'aa:bb:cc:dd:ee:ff',
        broadcast: '192.168.1.255',
        port: 7,
        label: 'x'.repeat(64)
      }).success
    ).toBe(true)
  })
})

const MAC_PATTERN = /([0-9a-f]{2}[:-]){5}[0-9a-f]{2}/i

describe('host.wake.admin grants and target removal', () => {
  const sent: number[] = []
  const knownDevices = new Set(['dev-a'])

  function authority(): WakeDeviceAuthority {
    return {
      authorize: (token) =>
        token === 'tok-a' && knownDevices.has('dev-a')
          ? { ok: true, deviceId: 'dev-a' }
          : { ok: false, reason: 'unknown_token' },
      deviceExists: (deviceId) => knownDevices.has(deviceId)
    }
  }

  const phone: RpcContext = {
    ...LOCAL,
    clientId: 'tok-a',
    pairedDeviceId: 'dev-a',
    clientKind: 'mobile'
  }

  async function wake(targetId: string, requestId: string): Promise<Outcome> {
    const request = HOST_WAKE_METHODS.find((m) => m.name === 'host.wake.request')
    if (!request || isStreamingMethod(request)) {
      throw new Error('host.wake.request must be a request method')
    }
    try {
      return { ok: true, result: await request.handler({ targetId, requestId }, phone) }
    } catch (error) {
      return { ok: false, error: mapRuntimeError('req-2', { runtimeId: 'broker-1' }, error).error }
    }
  }

  async function addTarget(label: string): Promise<string> {
    const added = await call('host.wake.admin.targetAdd', { mac: 'aa:bb:cc:dd:ee:01', label })
    return (added as { result: { target: { targetId: string } } }).result.target.targetId
  }

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'orca-wake-admin-'))
    startWakeBroker(userData, {
      sendMagicPacket: async () => {
        sent.push(1)
      }
    })
    wakeBrokerHost.attachDeviceAuthority(authority())
  })

  afterEach(() => {
    wakeBrokerHost.disable()
    wakeBrokerHost.attachDeviceAuthority(null)
    sent.length = 0
    rmSync(userData, { recursive: true, force: true })
  })

  it('stores a grant for a known device and lists it without a MAC', async () => {
    const targetId = await addTarget('desk')
    const added = await call('host.wake.admin.grantAdd', { deviceId: 'dev-a', targetId })
    expect(added.ok && added.result).toEqual({
      grant: { deviceId: 'dev-a', targetId, grantedAt: expect.any(Number) }
    })
    const listed = await call('host.wake.admin.grantList', null)
    expect(listed.ok && listed.result).toEqual({
      grants: [{ deviceId: 'dev-a', targetId, grantedAt: expect.any(Number) }]
    })
    expect(JSON.stringify(listed)).not.toMatch(MAC_PATTERN)
    expect(JSON.stringify(added)).not.toMatch(MAC_PATTERN)
  })

  it('refuses a grant for an unknown or revoked device with wake_device_unknown and stores nothing', async () => {
    const targetId = await addTarget('desk')
    expect(
      refusalCode(await call('host.wake.admin.grantAdd', { deviceId: 'dev-gone', targetId }))
    ).toBe('wake_device_unknown')
    const listed = await call('host.wake.admin.grantList', null)
    expect(listed.ok && listed.result).toEqual({ grants: [] })
  })

  it('refuses a grant with wake_broker_unavailable while the device registry is unreadable and writes nothing to disk', async () => {
    const targetId = await addTarget('desk')
    wakeBrokerHost.attachDeviceAuthority({
      authorize: () => ({ ok: false, reason: 'registry_unavailable' }),
      deviceState: (deviceId) => wakeDeviceState(null, deviceId)
    })
    const refused = await call('host.wake.admin.grantAdd', { deviceId: 'dev-a', targetId })
    expect(refusalCode(refused)).toBe('wake_broker_unavailable')
    expect(JSON.stringify(refused)).toContain('device_registry_unavailable')
    const listed = await call('host.wake.admin.grantList', null)
    expect(listed.ok && listed.result).toEqual({ grants: [] })
    const reloaded = loadWakeBrokerStore(userData)
    expect(reloaded.ok && reloaded.store.grants()).toEqual([])
  })

  it('persists a grant for a device the readable registry reports present', async () => {
    const targetId = await addTarget('desk')
    wakeBrokerHost.attachDeviceAuthority({
      authorize: () => ({ ok: false, reason: 'unknown_token' }),
      deviceState: (deviceId) =>
        wakeDeviceState(
          {
            getAvailability: () => ({ available: true }),
            getDevice: (id) => (id === 'dev-a' ? { deviceId: id } : null)
          },
          deviceId
        )
    })
    const added = await call('host.wake.admin.grantAdd', { deviceId: 'dev-a', targetId })
    expect(added.ok).toBe(true)
    const reloaded = loadWakeBrokerStore(userData)
    expect(reloaded.ok && reloaded.store.grants().map((grant) => grant.deviceId)).toEqual(['dev-a'])
  })

  it('refuses a grant for an unregistered target with wake_target_unknown', async () => {
    expect(
      refusalCode(
        await call('host.wake.admin.grantAdd', { deviceId: 'dev-a', targetId: 'wt_ffffffffffff' })
      )
    ).toBe('wake_target_unknown')
  })

  it('refuses a grant with wake_broker_unavailable while no device authority is attached', async () => {
    const targetId = await addTarget('desk')
    wakeBrokerHost.attachDeviceAuthority(null)
    expect(
      refusalCode(await call('host.wake.admin.grantAdd', { deviceId: 'dev-a', targetId }))
    ).toBe('wake_broker_unavailable')
  })

  it('removes a grant once, after which the device is refused wake_grant_missing', async () => {
    const targetId = await addTarget('desk')
    await call('host.wake.admin.grantAdd', { deviceId: 'dev-a', targetId })
    const before = await wake(targetId, 'req-00000001')
    expect(before.ok).toBe(true)
    expect(sent).toHaveLength(1)

    const first = await call('host.wake.admin.grantRemove', { deviceId: 'dev-a', targetId })
    const second = await call('host.wake.admin.grantRemove', { deviceId: 'dev-a', targetId })
    expect(first.ok && first.result).toEqual({ removed: true })
    expect(second.ok && second.result).toEqual({ removed: false })

    expect(refusalCode(await wake(targetId, 'req-00000002'))).toBe('wake_grant_missing')
    expect(sent).toHaveLength(1)
  })

  it('removes a target together with its grants and refuses an unknown target id', async () => {
    const targetId = await addTarget('desk')
    const keptId = await addTarget('nas')
    await call('host.wake.admin.grantAdd', { deviceId: 'dev-a', targetId })
    await call('host.wake.admin.grantAdd', { deviceId: 'dev-a', targetId: keptId })

    const removed = await call('host.wake.admin.targetRemove', { targetId })
    expect(removed.ok && removed.result).toEqual({ removed: true, targetId })
    const targets = await call('host.wake.admin.targetList', null)
    expect(
      (targets as { result: { targets: { targetId: string }[] } }).result.targets.map(
        (target) => target.targetId
      )
    ).toEqual([keptId])
    const grants = await call('host.wake.admin.grantList', null)
    expect(
      (grants as { result: { grants: { targetId: string }[] } }).result.grants.map(
        (grant) => grant.targetId
      )
    ).toEqual([keptId])
    const reloaded = loadWakeBrokerStore(userData)
    expect(reloaded.ok && reloaded.store.grants().map((grant) => grant.targetId)).toEqual([keptId])

    expect(refusalCode(await call('host.wake.admin.targetRemove', { targetId }))).toBe(
      'wake_target_unknown'
    )
  })

  it.each(REMOTE_CONTEXTS)(
    'refuses every grant and removal method for a non-local caller (%s) and changes nothing',
    async (_label, ctx) => {
      const targetId = await addTarget('desk')
      await call('host.wake.admin.grantAdd', { deviceId: 'dev-a', targetId })
      const attempts = [
        call('host.wake.admin.grantAdd', { deviceId: 'dev-a', targetId: 'wt_ffffffffffff' }, ctx),
        call('host.wake.admin.grantRemove', { deviceId: 'dev-a', targetId }, ctx),
        call('host.wake.admin.grantList', null, ctx),
        call('host.wake.admin.targetRemove', { targetId }, ctx)
      ]
      for (const outcome of await Promise.all(attempts)) {
        expect(refusalCode(outcome)).toBe('remote_caller_refused')
      }
      const reloaded = loadWakeBrokerStore(userData)
      expect(reloaded.ok && reloaded.store.targets().map((target) => target.targetId)).toEqual([
        targetId
      ])
      expect(reloaded.ok && reloaded.store.grants().length).toBe(1)
    }
  )
})
