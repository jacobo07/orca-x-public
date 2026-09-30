import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assertDeviceStillAuthorized, deviceRefusalDetail } from './device-authorization'
import { DeviceRegistry } from './device-registry'
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

describe('deviceRefusalDetail', () => {
  it('V-REV-DETAIL: only device_revoked carries data; the others keep today plain auth failure', () => {
    expect(deviceRefusalDetail('device_revoked').data).toEqual({ reason: 'device_revoked' })
    expect(deviceRefusalDetail('unknown_token').data).toBeUndefined()
    expect(deviceRefusalDetail('registry_unavailable').data).toBeUndefined()
  })
})
