import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from './orca-runtime'
import { isStreamingMethod, type RpcContext } from './rpc/core'
import { mapRuntimeError } from './rpc/errors'
import { HOST_WAKE_METHODS } from './rpc/methods/host-wake'
import type { WakeDeviceAuthority } from './wake-broker'
import { startWakeBroker, wakeBrokerHost, wakeBrokerRuntimeCapabilities } from './wake-broker-host'
import { loadWakeBrokerStore, WAKE_BROKER_STATE_FILENAME } from './wake-broker-store'

type Sent = { frame: Buffer; address: string; port: number }

let dir: string
const sent: Sent[] = []
const recordSend = async (frame: Buffer, address: string, port: number): Promise<void> => {
  sent.push({ frame, address, port })
}

function authority(devices: Record<string, string>): WakeDeviceAuthority {
  return {
    authorize: (token) => {
      const deviceId = devices[token]
      return deviceId ? { ok: true, deviceId } : { ok: false, reason: 'unknown_token' }
    },
    deviceExists: (deviceId) => Object.values(devices).includes(deviceId)
  }
}

function seedStore(grantDevices: string[]): string {
  const loaded = loadWakeBrokerStore(dir)
  if (!loaded.ok) {
    throw new Error(`seed store failed: ${loaded.reason}`)
  }
  const target = loaded.store.addTarget({
    mac: 'aa:bb:cc:dd:ee:01',
    broadcast: '192.168.1.255',
    port: 9,
    label: 'Desk'
  })
  for (const deviceId of grantDevices) {
    loaded.store.addGrant(deviceId, target.targetId)
  }
  return target.targetId
}

function deviceCtx(token: string, deviceId: string): RpcContext {
  return {
    runtime: {} as OrcaRuntimeService,
    clientId: token,
    pairedDeviceId: deviceId,
    clientKind: 'mobile'
  }
}

async function wakeRequest(
  targetId: string,
  ctx: RpcContext
): Promise<{ ok: true; result: unknown } | { ok: false; code: string }> {
  const method = HOST_WAKE_METHODS.find((m) => m.name === 'host.wake.request')
  if (!method || isStreamingMethod(method)) {
    throw new Error('host.wake.request must be a request method')
  }
  try {
    const params = method.params!.parse({ targetId, requestId: 'req-00000001' })
    return { ok: true, result: await method.handler(params, ctx) }
  } catch (error) {
    return { ok: false, code: mapRuntimeError('req-1', { runtimeId: 'r' }, error).error.code }
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-wake-broker-host-'))
})

afterEach(() => {
  wakeBrokerHost.disable()
  wakeBrokerHost.attachDeviceAuthority(null)
  sent.length = 0
  rmSync(dir, { recursive: true, force: true })
})

describe('startWakeBroker', () => {
  it('enables an empty broker when no state file exists and advertises the capability', () => {
    expect(wakeBrokerRuntimeCapabilities()).toEqual([])
    expect(startWakeBroker(dir, { sendMagicPacket: recordSend })).toEqual({
      state: 'enabled',
      targetCount: 0
    })
    expect(wakeBrokerRuntimeCapabilities()).toEqual(['host.wake-broker.v1'])
  })

  it('routes a granted request on the enabled broker to the injected sender', async () => {
    const targetId = seedStore(['dev-a'])
    expect(startWakeBroker(dir, { sendMagicPacket: recordSend })).toEqual({
      state: 'enabled',
      targetCount: 1
    })
    wakeBrokerHost.attachDeviceAuthority(authority({ 'tok-a': 'dev-a' }))
    const outcome = await wakeRequest(targetId, deviceCtx('tok-a', 'dev-a'))
    expect(outcome.ok).toBe(true)
    expect(sent).toHaveLength(1)
    expect(sent[0].frame.length).toBe(102)
    expect(sent[0].address).toBe('192.168.1.255')
  })

  it('fails closed on a corrupt state file and preserves its bytes', async () => {
    const corrupt = '{"schema":1,"targets":[{"bad":true}],"grants":[]}'
    writeFileSync(join(dir, WAKE_BROKER_STATE_FILENAME), corrupt)
    expect(startWakeBroker(dir, { sendMagicPacket: recordSend })).toEqual({
      state: 'unavailable',
      reason: 'wake_broker_state_unreadable'
    })
    expect(wakeBrokerHost.current()).toBeNull()
    expect(wakeBrokerHost.unavailableReason()).toBe('wake_broker_state_unreadable')
    expect(wakeBrokerRuntimeCapabilities()).toEqual([])
    wakeBrokerHost.attachDeviceAuthority(authority({ 'tok-a': 'dev-a' }))
    const outcome = await wakeRequest('wt_000000000001', deviceCtx('tok-a', 'dev-a'))
    expect(outcome).toEqual({ ok: false, code: 'wake_broker_unavailable' })
    expect(sent).toHaveLength(0)
    const preserved = readdirSync(dir).filter((name) =>
      name.startsWith(`${WAKE_BROKER_STATE_FILENAME}.corrupt-`)
    )
    expect(preserved).toHaveLength(1)
    expect(readFileSync(join(dir, preserved[0]), 'utf8')).toBe(corrupt)
  })

  it('prunes grants of devices that no longer exist when an authority is attached at start', () => {
    seedStore(['dev-a', 'dev-gone'])
    wakeBrokerHost.attachDeviceAuthority(authority({ 'tok-a': 'dev-a' }))
    startWakeBroker(dir, { sendMagicPacket: recordSend })
    const reloaded = loadWakeBrokerStore(dir)
    expect(reloaded.ok && reloaded.store.grants().map((g) => g.deviceId)).toEqual(['dev-a'])
  })

  it('keeps every grant when no authority is attached at start', () => {
    seedStore(['dev-a', 'dev-gone'])
    startWakeBroker(dir, { sendMagicPacket: recordSend })
    const reloaded = loadWakeBrokerStore(dir)
    expect(
      reloaded.ok &&
        reloaded.store
          .grants()
          .map((g) => g.deviceId)
          .sort()
    ).toEqual(['dev-a', 'dev-gone'])
  })

  it('still enables, without the pruned grant, when the prune cannot be persisted', () => {
    const targetId = seedStore(['dev-a', 'dev-gone'])
    wakeBrokerHost.attachDeviceAuthority(authority({ 'tok-a': 'dev-a' }))
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const result = startWakeBroker(dir, {
      sendMagicPacket: recordSend,
      publish: () => {
        throw Object.assign(new Error('disk full'), { code: 'ENOSPC' })
      }
    })
    expect(result).toEqual({ state: 'enabled', targetCount: 1 })
    expect(errors).toHaveBeenCalledWith('[wake-broker] grant prune not persisted: ENOSPC')
    errors.mockRestore()
    expect(wakeBrokerHost.current()?.store.hasGrant('dev-gone', targetId)).toBe(false)
    expect(wakeBrokerHost.current()?.store.hasGrant('dev-a', targetId)).toBe(true)
  })
})
