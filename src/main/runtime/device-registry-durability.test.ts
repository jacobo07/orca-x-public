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

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  const record = <A extends unknown[], R>(name: string, fn: (...args: A) => R, argAt?: number) => {
    return (...args: A): R => {
      syscalls.push({ name, arg: argAt === undefined ? undefined : String(args[argAt]) })
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
