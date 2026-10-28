import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  assertDeviceStillAuthorized,
  deviceRefusalDetail,
  revokeDeviceAndTerminateConnections
} from './device-authorization'
import { DeviceRegistry, type DeviceEntry } from './device-registry'
import { DEVICE_REGISTRY_FILENAME } from './mobile-pairing-files'

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'orca-device-authorization-'))
}

describe('assertDeviceStillAuthorized', () => {
  it('V-REV-AUTH-OK: a live device is authorized and returned', () => {
    const registry = new DeviceRegistry(freshDir())
    const device = registry.addDevice('phone', 'mobile')

    const result = assertDeviceStillAuthorized(registry, device.token)

    expect(result).toEqual({ ok: true, device })
  })

  it('V-REV-AUTH-UNKNOWN: a never-issued token is unknown_token', () => {
    const registry = new DeviceRegistry(freshDir())

    expect(assertDeviceStillAuthorized(registry, 'never-issued')).toEqual({
      ok: false,
      reason: 'unknown_token'
    })
  })

  it('V-REV-AUTH-UNAVAILABLE: an unreadable registry refuses as registry_unavailable, not unknown_token', () => {
    const dir = freshDir()
    writeFileSync(join(dir, DEVICE_REGISTRY_FILENAME), '{not json', 'utf-8')
    const registry = new DeviceRegistry(dir)

    expect(assertDeviceStillAuthorized(registry, 'anything')).toEqual({
      ok: false,
      reason: 'registry_unavailable'
    })
  })
})

describe('revocation reaches the authority', () => {
  it('V-REV-AUTH-REVOKED: a removed device is device_revoked, distinct from unknown_token', () => {
    const registry = new DeviceRegistry(freshDir())
    const device = registry.addDevice('phone', 'runtime')

    registry.removeDevice(device.deviceId)

    expect(assertDeviceStillAuthorized(registry, device.token)).toEqual({
      ok: false,
      reason: 'device_revoked'
    })
  })

  it('V-REV-TERMINATE-ON-SAVE-FAILURE: sockets are terminated even when the revoke throws, and the error propagates', () => {
    const device = { deviceId: 'd', token: 'tok' } as DeviceEntry
    const terminated: string[] = []
    const registry = {
      removeDevice: () => {
        throw new Error('save failed')
      },
      getDevice: () => null
    } as unknown as DeviceRegistry

    expect(() =>
      revokeDeviceAndTerminateConnections(registry, device, (token) => terminated.push(token))
    ).toThrow('save failed')
    expect(terminated).toEqual(['tok'])
  })

  it('V-REV-TERMINATE-CONTROL: a device that is still registered is not terminated', () => {
    const device = { deviceId: 'd', token: 'tok' } as DeviceEntry
    const terminated: string[] = []
    const registry = {
      removeDevice: () => false,
      getDevice: () => device
    } as unknown as DeviceRegistry

    expect(revokeDeviceAndTerminateConnections(registry, device, (t) => terminated.push(t))).toBe(
      false
    )
    expect(terminated).toEqual([])
  })
})

describe('deviceRefusalDetail', () => {
  it('V-REV-DETAIL: only device_revoked carries data; the others keep today plain auth failure', () => {
    expect(deviceRefusalDetail('device_revoked').data).toEqual({ reason: 'device_revoked' })
    expect(deviceRefusalDetail('unknown_token').data).toBeUndefined()
    expect(deviceRefusalDetail('registry_unavailable').data).toBeUndefined()
  })
})
