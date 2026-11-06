import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as SecureFile from './secure-file'

const { writes, failing } = vi.hoisted(() => ({
  writes: [] as { path: string; durable?: boolean }[],
  failing: { path: '' }
}))

vi.mock('./secure-file', async (importOriginal) => {
  const actual = await importOriginal<typeof SecureFile>()
  return {
    ...actual,
    writeSecureFile: (path: string, contents: string, options: { durable?: boolean } = {}) => {
      writes.push({ path, durable: options.durable })
      if (path === failing.path) {
        throw new Error('disk full')
      }
      actual.writeSecureFile(path, contents, options)
    }
  }
})

import { encodePairingOffer } from './pairing'
import {
  addEnvironmentFromPairingCode,
  getEnvironmentStorePath,
  listEnvironments,
  markEnvironmentUsed,
  removeEnvironment,
  RuntimeEnvironmentStoreError
} from './runtime-environment-store'

function pairingCode(deviceToken = 'device-token'): string {
  return encodePairingOffer({
    v: 2,
    endpoint: 'ws://127.0.0.1:6768',
    deviceToken,
    publicKeyB64: Buffer.from(new Uint8Array(32).fill(1)).toString('base64')
  })
}

describe('runtime environment store durability', () => {
  let userData = ''
  let path = ''

  beforeEach(() => {
    writes.length = 0
    failing.path = ''
    userData = mkdtempSync(join(tmpdir(), 'orca-env-durable-'))
    path = getEnvironmentStorePath(userData)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(userData, { recursive: true, force: true })
  })

  const addServer = (name = 'gex44', token?: string) =>
    addEnvironmentFromPairingCode(userData, { name, pairingCode: pairingCode(token) })

  it('flushes every write of the credential file and its backup', () => {
    addServer()

    expect(writes.map((w) => w.path)).toEqual([path, `${path}.bak`])
    expect(writes.every((w) => w.durable === true)).toBe(true)
  })

  it('restores a zero-filled file from its backup and keeps the damaged copy', () => {
    const saved = addServer()
    writeFileSync(path, Buffer.alloc(1854))

    expect(listEnvironments(userData)).toEqual([saved])

    const damaged = readdirSync(userData).filter((f) => f.includes('.corrupt-'))
    expect(damaged).toHaveLength(1)
    expect(readFileSync(join(userData, damaged[0]!))).toEqual(Buffer.alloc(1854))
    expect(listEnvironments(userData)).toEqual([saved])
  })

  it('still refuses when the backup is damaged too, and changes nothing', () => {
    addServer()
    writeFileSync(path, Buffer.alloc(100))
    writeFileSync(`${path}.bak`, Buffer.alloc(100))

    expect(() => listEnvironments(userData)).toThrow(RuntimeEnvironmentStoreError)

    expect(readdirSync(userData).filter((f) => f.includes('.corrupt-'))).toEqual([])
  })

  it('refuses a damaged file with no backup instead of reading it as empty', () => {
    writeFileSync(path, Buffer.alloc(100))

    expect(() => listEnvironments(userData)).toThrow(RuntimeEnvironmentStoreError)
  })

  it('leaves no token of a removed server in the backup', () => {
    addServer('keep', 'token-keep')
    addServer('gone', 'token-gone')

    removeEnvironment(userData, 'gone')

    const backup = readFileSync(`${path}.bak`, 'utf8')
    expect(backup).toContain('keep')
    expect(backup).not.toContain('"gone"')
    expect(backup).not.toContain('token-gone')
  })

  it('never reads a failed restore as empty, so the next save cannot destroy the backup', () => {
    addServer()
    const backup = readFileSync(`${path}.bak`, 'utf8')
    writeFileSync(path, Buffer.alloc(100))
    failing.path = path

    expect(() => listEnvironments(userData)).toThrow(RuntimeEnvironmentStoreError)
    expect(() => addServer('new')).toThrow(RuntimeEnvironmentStoreError)

    expect(existsSync(path)).toBe(true)
    expect(readFileSync(`${path}.bak`, 'utf8')).toBe(backup)
  })

  it('restores a missing primary from the backup instead of reading it as empty', () => {
    const saved = addServer()
    rmSync(path)

    expect(listEnvironments(userData)).toEqual([saved])
  })

  it.each([
    ['a newer format', '{"version":2,"environments":[]}'],
    ['an oversized file', 'x'.repeat(1024 * 1024 + 1)]
  ])('refuses %s instead of replacing it with an older backup', (_label, content) => {
    addServer()
    writeFileSync(path, content)

    expect(() => listEnvironments(userData)).toThrow(RuntimeEnvironmentStoreError)

    expect(readFileSync(path, 'utf8')).toBe(content)
    expect(readdirSync(userData).filter((f) => f.includes('.corrupt-'))).toEqual([])
  })

  it('reports a save as done when only the backup failed, and leaves no stale backup', () => {
    addServer('keep')
    failing.path = `${path}.bak`

    addServer('new')

    expect(listEnvironments(userData).map((e) => e.name)).toEqual(['keep', 'new'])
    expect(existsSync(`${path}.bak`)).toBe(false)
  })

  it('does not rewrite the backup for a usage stamp, which changes no token', () => {
    const saved = addServer()
    writes.length = 0

    markEnvironmentUsed(userData, saved.id, { now: saved.createdAt + 120_000 })

    expect(writes.map((w) => w.path)).toEqual([path])
  })

  it('recreates a missing backup on the next usage stamp, so the store does not stay unprotected', () => {
    const saved = addServer()
    rmSync(`${path}.bak`)

    markEnvironmentUsed(userData, saved.id, { now: saved.createdAt + 120_000 })

    expect(existsSync(`${path}.bak`)).toBe(true)
  })

  it('needs no backup for an empty first run', () => {
    expect(listEnvironments(userData)).toEqual([])
    expect(existsSync(`${path}.bak`)).toBe(false)
  })
})
