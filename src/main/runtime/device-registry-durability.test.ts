import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type * as NodeFs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Why this file exists: orca-devices.json is the only copy of every pairing credential, so a torn
 * or non-fsynced publish loses every pairing. The proof is syscall order, because a text match on the
 * writer cannot tell an fsync before the rename from one after it.
 */

const syscalls: { name: string; arg?: string }[] = []
// Why: lets a test make the durable publish fail, to prove a revoke does not depend on the save landing.
const publishFailure = { renameThrows: false }

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  const record = <A extends unknown[], R>(name: string, fn: (...args: A) => R, argAt?: number) => {
    return (...args: A): R => {
      syscalls.push({ name, arg: argAt === undefined ? undefined : String(args[argAt]) })
      if (name === 'renameSync' && publishFailure.renameThrows) {
        throw new Error('injected publish failure')
      }
      return fn(...args)
    }
  }
  return {
    ...actual,
    default: actual,
    fsyncSync: record('fsyncSync', actual.fsyncSync),
    renameSync: record('renameSync', actual.renameSync, 1)
  }
})

const { DeviceRegistry } = await import('./device-registry')
const { assertDeviceStillAuthorized } = await import('./device-authorization')

let dir: string

beforeEach(() => {
  syscalls.length = 0
  dir = mkdtempSync(join(tmpdir(), 'orca-devreg-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const names = () => syscalls.map((call) => call.name)

describe('the registry publish is durable', () => {
  it('V-REG-FSYNC-ORDER: fsyncs the staged file before renaming it onto orca-devices.json', () => {
    // Arrange
    const registry = new DeviceRegistry(dir)

    // Act
    registry.addDevice('x')

    // Assert
    const fsyncAt = names().indexOf('fsyncSync')
    const renameAt = names().indexOf('renameSync')
    expect(fsyncAt, 'no fsync recorded — the registry is not crash-durable').toBeGreaterThanOrEqual(0)
    expect(renameAt).toBeGreaterThanOrEqual(0)
    expect(fsyncAt).toBeLessThan(renameAt)
    expect(syscalls[renameAt]!.arg).toBe(join(dir, 'orca-devices.json'))
  })

  it('V-REG-ROUNDTRIP: a device added in one instance validates by token in a fresh one', () => {
    // Arrange
    const entry = new DeviceRegistry(dir).addDevice('phone')

    // Act
    const reloaded = new DeviceRegistry(dir).validateToken(entry.token)

    // Assert
    expect(reloaded?.deviceId).toBe(entry.deviceId)
  })

  const mutators: [string, (registry: InstanceType<typeof DeviceRegistry>) => void][] = [
    ['addDevice', (r) => void r.addDevice('a')],
    [
      'setPairingReach',
      (r) => {
        r.addDevice('a', 'mobile', 'this-computer')
        syscalls.length = 0
        r.getOrCreatePendingDevice('a', 'mobile', 'network')
      }
    ],
    ['rotatePendingDevice', (r) => void r.rotatePendingDevice('a')],
    [
      'removeDevice',
      (r) => {
        const id = r.addDevice('a').deviceId
        syscalls.length = 0
        r.removeDevice(id)
      }
    ],
    [
      'setRelayBinding',
      (r) => {
        const id = r.addDevice('a').deviceId
        syscalls.length = 0
        r.setRelayBinding(id, { relayHostId: 'h', relayDeviceId: id, ownerIdentityKey: 'k' })
      }
    ],
    [
      'setMobilePairingConnectionMode',
      (r) => {
        const id = r.addDevice('a').deviceId
        syscalls.length = 0
        r.setMobilePairingConnectionMode(id, 'local-only')
      }
    ],
    [
      'updateLastSeen',
      (r) => {
        const id = r.addDevice('a').deviceId
        syscalls.length = 0
        r.updateLastSeen(id)
      }
    ],
    [
      'flushPendingLastSeen',
      (r) => {
        const id = r.addDevice('a').deviceId
        r.updateLastSeen(id)
        r.updateLastSeenDeferred(id)
        syscalls.length = 0
        r.flushPendingLastSeen()
      }
    ]
  ]

  it.each(mutators)('V-REG-FSYNC-ORDER-ALL: %s fsyncs before it renames', (_name, run) => {
    // Arrange
    const registry = new DeviceRegistry(dir)

    // Act
    run(registry)

    // Assert
    const fsyncAt = names().indexOf('fsyncSync')
    const renameAt = names().indexOf('renameSync')
    expect(fsyncAt, 'this mutator published without an fsync').toBeGreaterThanOrEqual(0)
    expect(renameAt).toBeGreaterThanOrEqual(0)
    expect(fsyncAt).toBeLessThan(renameAt)
  })
})

describe('an unreadable registry is preserved and fails closed', () => {
  const registryFile = () => join(dir, 'orca-devices.json')
  const corruptSiblings = () =>
    readdirSync(dir).filter((file) => /^orca-devices\.json\.corrupt-\d+$/.test(file))

  it.each([
    ['V-REG-CORRUPT-PRESERVED', '{not json'],
    ['V-REG-TRUNCATED', ''],
    ['V-REG-NOT-AN-ARRAY', '{"devices":[]}']
  ])('%s: keeps the bytes, rejects every token, refuses to pair', (_id, bytes) => {
    // Arrange
    writeFileSync(registryFile(), bytes)

    // Act
    const registry = new DeviceRegistry(dir)

    // Assert
    const siblings = corruptSiblings()
    expect(siblings).toHaveLength(1)
    expect(readFileSync(join(dir, siblings[0]!), 'utf-8')).toBe(bytes)
    expect(registry.getAvailability().available).toBe(false)
    expect(registry.validateToken('anything')).toBeNull()
    expect(() => registry.addDevice('phone')).toThrow(/device_registry_unavailable/)
    expect(existsSync(registryFile()), 'a registry was published over the corrupt one').toBe(false)
  })

  it('V-REG-UNAVAILABLE-HANDSHAKE: the deferred lastSeen path returns instead of crashing', () => {
    // Arrange
    writeFileSync(registryFile(), '{not json')
    const registry = new DeviceRegistry(dir)

    // Act / Assert
    expect(() => registry.updateLastSeenDeferred('x')).not.toThrow()
    expect(() => registry.flushPendingLastSeen()).not.toThrow()
  })

  it('V-REG-MISSING-EMPTY: no file is an empty, available registry (control)', () => {
    // Arrange / Act
    const registry = new DeviceRegistry(dir)

    // Assert
    expect(registry.getAvailability()).toEqual({ available: true })
    expect(registry.addDevice('phone').name).toBe('phone')
    expect(corruptSiblings()).toHaveLength(0)
  })

  it('V-REG-LEGACY-ARRAY: an entry without scope or reach loads with the old defaults', () => {
    // Arrange
    writeFileSync(
      registryFile(),
      JSON.stringify([{ deviceId: 'd1', name: 'old', token: 't1', pairedAt: 1, lastSeenAt: 2 }])
    )

    // Act
    const loaded = new DeviceRegistry(dir).validateToken('t1')

    // Assert
    expect(loaded?.scope).toBe('mobile')
    expect(loaded?.pairingReach).toBe('network')
  })
})

describe('revocation is a durable, distinct, bounded, fail-closed fact', () => {
  const registryFile = () => join(dir, 'orca-devices.json')
  const readEnvelope = () =>
    JSON.parse(readFileSync(registryFile(), 'utf-8')) as {
      version: number
      devices: { deviceId: string }[]
      revoked: { deviceId: string; tokenHash: string; revokedAt: number }[]
    }
  const tombstone = (n: number, revokedAt: number) => ({
    deviceId: `gone-${n}`,
    tokenHash: `hash-${n}`,
    revokedAt
  })

  afterEach(() => {
    publishFailure.renameThrows = false
    vi.useRealTimers()
  })

  it('V-REV-REASON: a revoked token is device_revoked, a never-issued one is unknown_token', () => {
    // Arrange
    const registry = new DeviceRegistry(dir)
    const device = registry.addDevice('phone')

    // Act
    registry.removeDevice(device.deviceId)

    // Assert
    expect(assertDeviceStillAuthorized(registry, device.token)).toEqual({
      ok: false,
      reason: 'device_revoked'
    })
    expect(assertDeviceStillAuthorized(registry, 'never-issued')).toEqual({
      ok: false,
      reason: 'unknown_token'
    })
  })

  it('V-REV-RESTART: the reason survives a restart and the file never holds the token', () => {
    // Arrange
    const first = new DeviceRegistry(dir)
    const device = first.addDevice('phone')
    first.removeDevice(device.deviceId)

    // Act
    const restarted = new DeviceRegistry(dir)

    // Assert
    expect(assertDeviceStillAuthorized(restarted, device.token)).toEqual({
      ok: false,
      reason: 'device_revoked'
    })
    expect(readFileSync(registryFile(), 'utf-8')).not.toContain(device.token)
    expect(readEnvelope().revoked[0]!.tokenHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('V-REV-FUTURE-VERSION: an envelope this build does not know is preserved and fails closed, never reinterpreted', () => {
    // Arrange
    const bytes = JSON.stringify({ version: 3, devices: [], revoked: [] })
    writeFileSync(registryFile(), bytes)

    // Act
    const registry = new DeviceRegistry(dir)

    // Assert
    const siblings = readdirSync(dir).filter((f) => /^orca-devices\.json\.corrupt-\d+$/.test(f))
    expect(registry.getAvailability().available).toBe(false)
    expect(siblings).toHaveLength(1)
    expect(readFileSync(join(dir, siblings[0]!), 'utf-8')).toBe(bytes)
    expect(() => registry.addDevice('phone')).toThrow(/device_registry_unavailable/)
  })

  it('V-REV-V1-READ: a v1 bare array loads, and the next save writes the v2 envelope', () => {
    // Arrange
    writeFileSync(
      registryFile(),
      JSON.stringify([{ deviceId: 'd1', name: 'old', token: 't1', pairedAt: 1, lastSeenAt: 2 }])
    )
    const registry = new DeviceRegistry(dir)

    // Act
    registry.addDevice('new')

    // Assert
    const envelope = readEnvelope()
    expect(envelope.version).toBe(2)
    expect(envelope.devices.map((d) => d.deviceId)).toContain('d1')
    expect(envelope.revoked).toEqual([])
  })

  it('V-REV-BOUND: tombstones are capped at 256 newest and none older than 90 days survives a write', () => {
    // Arrange
    const now = Date.UTC(2026, 8, 30)
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(now)
    const day = 24 * 60 * 60 * 1000
    const recent = Array.from({ length: 299 }, (_, n) => tombstone(n, now - day + n))
    writeFileSync(
      registryFile(),
      JSON.stringify({
        version: 2,
        devices: [
          { deviceId: 'live', name: 'p', token: 'live-token', pairedAt: 1, lastSeenAt: 2 }
        ],
        revoked: [tombstone(9000, now - 91 * day), ...recent]
      })
    )
    const registry = new DeviceRegistry(dir)

    // Act
    registry.removeDevice('live')

    // Assert
    const { revoked } = readEnvelope()
    expect(revoked).toHaveLength(256)
    expect(revoked.some((entry) => entry.deviceId === 'gone-9000')).toBe(false)
    expect(revoked.at(-1)!.deviceId).toBe('live')
    expect(revoked[0]!.deviceId).toBe('gone-44')
  })

  it('V-REV-SAVE-FAILURE: when the durable save throws, the revoke propagates and the device stays refused', () => {
    // Arrange
    const registry = new DeviceRegistry(dir)
    const device = registry.addDevice('phone')
    publishFailure.renameThrows = true

    // Act / Assert
    expect(() => registry.removeDevice(device.deviceId)).toThrow(/injected publish failure/)
    publishFailure.renameThrows = false
    expect(assertDeviceStillAuthorized(registry, device.token)).toEqual({
      ok: false,
      reason: 'device_revoked'
    })
    expect(registry.getDevice(device.deviceId)).toBeNull()
  })

  it('V-REV-GRANT-ORDER: a grant whose save throws is NOT valid afterwards (control for save-then-swap)', () => {
    // Arrange
    const registry = new DeviceRegistry(dir)
    publishFailure.renameThrows = true

    // Act / Assert
    expect(() => registry.addDevice('phone')).toThrow(/injected publish failure/)
    expect(registry.listDevices()).toHaveLength(0)
  })
})
