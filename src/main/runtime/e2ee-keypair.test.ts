import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import type * as NodeFs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Why this file exists: this host's fleet identity is `sha256(publicKey)` of the keypair written
 * here (`host-key-fingerprint.ts`), so a lost or replaced key voids every pairing. Two properties
 * are pinned: the mint is durable, and an existing-but-unusable file is never silently replaced.
 */

const syscalls: string[] = []
let failNextWriteWith: string | null = null

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  const record = <A extends unknown[], R>(name: string, fn: (...args: A) => R) => {
    return (...args: A): R => {
      if (name === 'writeFileSync' && failNextWriteWith) {
        const code = failNextWriteWith
        failNextWriteWith = null
        syscalls.push(`writeFileSync:failed:${code}`)
        throw Object.assign(new Error(`injected ${code}`), { code })
      }
      syscalls.push(name)
      return fn(...args)
    }
  }
  return {
    ...actual,
    default: actual,
    fsyncSync: record('fsyncSync', actual.fsyncSync),
    renameSync: record('renameSync', actual.renameSync),
    writeFileSync: record('writeFileSync', actual.writeFileSync)
  }
})

const {
  loadOrCreateE2EEKeypair,
  readE2EEPublicKey,
  forgetHostIdentity,
  E2EEKeypairUnusableError,
  E2EEKeypairUnreadableError
} = await import('./e2ee-keypair')

const KEYPAIR_FILENAME = 'orca-e2ee-keypair.json'

let dir: string

const keyFile = () => join(dir, KEYPAIR_FILENAME)

beforeEach(() => {
  syscalls.length = 0
  dir = mkdtempSync(join(tmpdir(), 'orca-e2ee-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('the mint is durable', () => {
  it('fsyncs the staged file before publishing it, so a torn write cannot fork this host identity', () => {
    // Arrange: no key file exists, so this call mints one.

    // Act
    loadOrCreateE2EEKeypair(dir)

    // Assert
    const fsyncAt = syscalls.indexOf('fsyncSync')
    const renameAt = syscalls.indexOf('renameSync')
    expect(
      fsyncAt,
      'the mint never fsynced — the identity root is not crash-durable'
    ).toBeGreaterThanOrEqual(0)
    expect(renameAt).toBeGreaterThanOrEqual(0)
    expect(fsyncAt).toBeLessThan(renameAt)
  })

  it('a mint whose write fails throws the storage error and leaves no identity behind', () => {
    // Arrange: the disk is full at the moment the new key is staged.
    failNextWriteWith = 'ENOSPC'

    // Act / Assert: the caller is told, and no in-memory key outlives the failed write.
    expect(() => loadOrCreateE2EEKeypair(dir)).toThrow(expect.objectContaining({ code: 'ENOSPC' }))
    expect(syscalls, 'the injected fault never fired').toContain('writeFileSync:failed:ENOSPC')
    expect(syscalls).not.toContain('renameSync')
    expect(readE2EEPublicKey(dir), 'a key was published despite the failed write').toBeUndefined()
  })
})

describe('an existing key is never silently replaced', () => {
  it('refuses a truncated file — the exact artifact of a non-fsynced write', () => {
    // Arrange: power loss during the write leaves a zero-length file.
    writeFileSync(keyFile(), '')

    // Act / Assert
    expect(() => loadOrCreateE2EEKeypair(dir)).toThrow(E2EEKeypairUnusableError)
    expect(readFileSync(keyFile(), 'utf-8'), 'the unusable file was overwritten').toBe('')
  })

  it('refuses a half-written file that does not parse', () => {
    // Arrange
    writeFileSync(keyFile(), '{"v":1,"publicKeyB64":"AAA')

    // Act / Assert
    expect(() => loadOrCreateE2EEKeypair(dir)).toThrow(E2EEKeypairUnusableError)
  })

  it('refuses a parseable file whose keys are the wrong length', () => {
    // Arrange: parses, right shape, but not a 32-byte curve25519 pair.
    writeFileSync(
      keyFile(),
      JSON.stringify({ v: 1, publicKeyB64: Buffer.alloc(8).toString('base64'), secretKeyB64: 'AA' })
    )

    // Act / Assert
    expect(() => loadOrCreateE2EEKeypair(dir)).toThrow(E2EEKeypairUnusableError)
  })

  it('names the file as present-but-unusable rather than absent', () => {
    // Arrange
    writeFileSync(keyFile(), '')

    // Act
    const observed = readE2EEPublicKey(dir)

    // Assert: null means "present and unusable", undefined would mean "no key here".
    expect(observed).toBeNull()
  })
})

describe('a key that could not be read is not a damaged key', () => {
  it('reports a read failure with its code, and replaces nothing', () => {
    // Arrange: a real read fault — the key path is a directory, so readFileSync fails with EISDIR.
    mkdirSync(keyFile())

    // Act
    let thrown: unknown
    try {
      loadOrCreateE2EEKeypair(dir)
    } catch (error) {
      thrown = error
    }

    // Assert: the fault fired, it was named as unreadable, and it was never called damage.
    expect(thrown).toBeInstanceOf(E2EEKeypairUnreadableError)
    expect(thrown).not.toBeInstanceOf(E2EEKeypairUnusableError)
    expect((thrown as { code: string }).code).toBe('EISDIR')
    expect(statSync(keyFile()).isDirectory(), 'the unreadable key path was replaced').toBe(true)
  })
})

describe('controls — the loader still works', () => {
  it('mints and persists when no key file exists', () => {
    // Act
    const created = loadOrCreateE2EEKeypair(dir)

    // Assert
    expect(created.publicKey).toHaveLength(32)
    expect(created.secretKey).toHaveLength(32)
    expect(readE2EEPublicKey(dir)).toBe(created.publicKeyB64)
  })

  it('returns the SAME identity on a second load, which is what pairing depends on', () => {
    // Arrange
    const first = loadOrCreateE2EEKeypair(dir)

    // Act
    const second = loadOrCreateE2EEKeypair(dir)

    // Assert
    expect(second.publicKeyB64).toBe(first.publicKeyB64)
  })
})

describe('recovery is deliberate', () => {
  it('forgetting the identity lets the next load mint a new one', () => {
    // Arrange: an unusable file that the loader now refuses.
    writeFileSync(keyFile(), '')
    expect(() => loadOrCreateE2EEKeypair(dir)).toThrow(E2EEKeypairUnusableError)

    // Act
    forgetHostIdentity(dir)
    const minted = loadOrCreateE2EEKeypair(dir)

    // Assert
    expect(minted.publicKey).toHaveLength(32)
    expect(readE2EEPublicKey(dir)).toBe(minted.publicKeyB64)
  })

  it('forgetting when nothing is there is not an error', () => {
    // Act / Assert
    expect(() => forgetHostIdentity(dir)).not.toThrow()
  })
})
