import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import nacl from 'tweetnacl'
import { afterEach, describe, expect, it } from 'vitest'
import { loadOrCreateE2EEKeypair, readE2EEPublicKey } from './e2ee-keypair'
import { fingerprintHostPublicKey } from './host-key-fingerprint'
import { E2EE_KEYPAIR_FILENAME } from './mobile-pairing-files'
import { fingerprintOrchestrationPeer } from './orchestration/environment-transport'

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orca-host-key-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('host key fingerprint', () => {
  it('matches the orchestration peer fingerprint for a real key', () => {
    const key = Buffer.from(nacl.box.keyPair().publicKey).toString('base64')
    expect(fingerprintHostPublicKey(key)).toBe(fingerprintOrchestrationPeer(key))
    expect(fingerprintHostPublicKey(key)).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it('refuses anything that is not exactly one 32-byte key', () => {
    const short = Buffer.alloc(31, 7).toString('base64')
    const long = Buffer.alloc(33, 7).toString('base64')
    const good = Buffer.alloc(32, 7).toString('base64')
    expect(fingerprintHostPublicKey(short)).toBeNull()
    expect(fingerprintHostPublicKey(long)).toBeNull()
    expect(fingerprintHostPublicKey(`${good.slice(0, 10)}!!${good.slice(10)}`)).toBeNull()
    expect(fingerprintHostPublicKey('')).toBeNull()
    expect(fingerprintHostPublicKey(good)).not.toBeNull()
  })
})

describe('reading this host key without side effects', () => {
  it('reports absence without creating a key', () => {
    const dir = tempDir()
    expect(readE2EEPublicKey(dir)).toBeUndefined()
    expect(readE2EEPublicKey(dir)).toBeUndefined()
  })

  it('reads the key the loader persisted', () => {
    const dir = tempDir()
    const created = loadOrCreateE2EEKeypair(dir)
    expect(readE2EEPublicKey(dir)).toBe(created.publicKeyB64)
  })

  it('reports a malformed file as unreadable and leaves its bytes alone', () => {
    const dir = tempDir()
    const file = join(dir, E2EE_KEYPAIR_FILENAME)
    writeFileSync(file, '{"v":1,"publicKeyB64":"AAAA","secretKeyB64":"AAAA"}')
    const before = readFileSync(file)
    expect(readE2EEPublicKey(dir)).toBeNull()
    expect(readFileSync(file).equals(before)).toBe(true)
    writeFileSync(file, 'not json')
    expect(readE2EEPublicKey(dir)).toBeNull()
    expect(readFileSync(file, 'utf8')).toBe('not json')
  })
})
