import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { revokeDeviceAndTerminateConnections } from './device-authorization'
import { DeviceRegistry } from './device-registry'
import { DEVICE_REGISTRY_FILENAME } from './mobile-pairing-files'

// D2 (docs/dws/d2-device-token-hashing-spec.md): a paired device's bearer token never rests on disk.

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-devreg-at-rest-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const registryText = () => readFileSync(join(dir, DEVICE_REGISTRY_FILENAME), 'utf-8')
const storedEntries = () => JSON.parse(registryText()) as Record<string, unknown>[]

describe('a paired device token at rest', () => {
  it('stores only the hash once the device is seen, and still authenticates after a restart', () => {
    const device = new DeviceRegistry(dir).addDevice('Phone')
    new DeviceRegistry(dir).updateLastSeen(device.deviceId)

    expect(registryText()).not.toContain(device.token)
    expect(storedEntries()[0]).toMatchObject({ tokenHash: sha256(device.token!) })
    expect(storedEntries()[0]).not.toHaveProperty('token')
    expect(new DeviceRegistry(dir).validateToken(device.token!)?.deviceId).toBe(device.deviceId)
  })

  it('keeps the pending token raw so an unscanned QR is re-advertised after a restart', () => {
    // Control for the case above: a gate that stripped every token would break pairing here.
    const pending = new DeviceRegistry(dir).getOrCreatePendingDevice('Phone')

    expect(registryText()).toContain(pending.token)
    expect(new DeviceRegistry(dir).getOrCreatePendingDevice('Phone').token).toBe(pending.token)
  })

  it('migrates a legacy registry at load: every device authenticates, only the pending token stays raw', () => {
    const paired = { deviceId: 'd-paired', token: 'a'.repeat(48), lastSeenAt: 1_000 }
    const pending = { deviceId: 'd-pending', token: 'b'.repeat(48), lastSeenAt: 0 }
    const legacy = [paired, pending].map((entry) => ({
      ...entry,
      name: entry.deviceId,
      scope: 'mobile',
      pairedAt: 1
    }))
    writeFileSync(join(dir, DEVICE_REGISTRY_FILENAME), JSON.stringify(legacy))

    const registry = new DeviceRegistry(dir)

    expect(registry.validateToken(paired.token)?.deviceId).toBe(paired.deviceId)
    expect(registry.validateToken(pending.token)?.deviceId).toBe(pending.deviceId)
    expect(registryText()).not.toContain(paired.token)
    expect(registryText()).toContain(pending.token)
  })

  it('still refuses a revoked token when the device was removed before it reconnected', () => {
    const device = new DeviceRegistry(dir).addDevice('Phone')
    new DeviceRegistry(dir).updateLastSeen(device.deviceId)
    const restarted = new DeviceRegistry(dir)

    expect(restarted.removeDevice(device.deviceId)).toBe(true)
    expect(restarted.validateToken(device.token!)).toBeNull()
    expect(restarted.isRevokedToken(device.token!)).toBe(true)
  })

  it('is refused, not accepted, by an older build that matches the raw token', () => {
    const device = new DeviceRegistry(dir).addDevice('Phone')
    new DeviceRegistry(dir).updateLastSeen(device.deviceId)

    // The lookup every build before D2 runs over this same file.
    const olderBuildMatch = storedEntries().find((entry) => entry.token === device.token)
    expect(olderBuildMatch).toBeUndefined()
  })
})

describe('revoking ends live sockets by the token the device presented', () => {
  it('terminates with the raw token once the device authenticated this run', () => {
    const device = new DeviceRegistry(dir).addDevice('Phone')
    new DeviceRegistry(dir).updateLastSeen(device.deviceId)
    const restarted = new DeviceRegistry(dir)
    const authenticated = restarted.validateToken(device.token!)!
    const terminate = vi.fn()

    revokeDeviceAndTerminateConnections(restarted, authenticated, terminate)

    expect(terminate).toHaveBeenCalledWith(device.token)
  })

  it('terminates nothing for a device that never connected this run: it has no sockets', () => {
    const device = new DeviceRegistry(dir).addDevice('Phone')
    new DeviceRegistry(dir).updateLastSeen(device.deviceId)
    const restarted = new DeviceRegistry(dir)
    const terminate = vi.fn()

    revokeDeviceAndTerminateConnections(restarted, restarted.getDevice(device.deviceId)!, terminate)

    expect(terminate).not.toHaveBeenCalled()
    expect(restarted.isRevokedToken(device.token!)).toBe(true)
  })
})
