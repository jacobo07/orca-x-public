import { mkdtempSync, rmSync } from 'node:fs'
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
})
