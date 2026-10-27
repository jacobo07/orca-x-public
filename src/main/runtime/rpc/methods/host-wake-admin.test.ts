import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { isStreamingMethod, type RpcContext, type RpcFailure } from '../core'
import { mapRuntimeError } from '../errors'
import { startWakeBroker, wakeBrokerHost } from '../../wake-broker-host'
import { loadWakeBrokerStore } from '../../wake-broker-store'
import { HOST_WAKE_ADMIN_METHODS } from './host-wake-admin'

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
