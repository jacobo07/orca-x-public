import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import nacl from 'tweetnacl'
import { afterEach, describe, expect, it } from 'vitest'
import { isHostKey } from '../../shared/host-wake'
import { hostKeyFromPublicKeyB64 } from '../../shared/host-wake-proxy'
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

// Why node:crypto here: the phone passes @noble/hashes sha256; both return the raw 32-byte digest.
function sha256(bytes: Uint8Array): Uint8Array {
  return createHash('sha256').update(bytes).digest()
}

const VECTOR_KEY_B64 = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8='
const VECTOR_HOST_KEY = 'Yw3NKWbEM2aRElRIu7JbT_QSpJxzLbLIq8G4WBvXEN0'

describe('phone-side hostKey derivation (hostKeyFromPublicKeyB64)', () => {
  it('equals the host fingerprint for 64 random 32-byte keys', () => {
    for (let index = 0; index < 64; index += 1) {
      const key = randomBytes(32).toString('base64')
      const derived = hostKeyFromPublicKeyB64(key, sha256)
      expect(derived, key).toBe(fingerprintHostPublicKey(key))
      expect(isHostKey(derived), key).toBe(true)
    }
  })

  it('agrees with the host on unpadded and double-padded text (atob and Buffer read the same bytes)', () => {
    for (let index = 0; index < 16; index += 1) {
      const padded = randomBytes(32).toString('base64')
      const unpadded = padded.replace(/=+$/, '')
      expect(unpadded).toHaveLength(43)
      const expected = fingerprintHostPublicKey(padded)
      expect(fingerprintHostPublicKey(unpadded), unpadded).toBe(expected)
      expect(hostKeyFromPublicKeyB64(unpadded, sha256), unpadded).toBe(expected)
      expect(fingerprintHostPublicKey(`${unpadded}==`), unpadded).toBe(expected)
      expect(hostKeyFromPublicKeyB64(`${unpadded}==`, sha256), unpadded).toBe(expected)
    }
  })

  it('hands the digest exactly the 32 decoded key bytes', () => {
    const key = randomBytes(32)
    const seen: Uint8Array[] = []
    hostKeyFromPublicKeyB64(key.toString('base64'), (bytes) => {
      seen.push(Uint8Array.from(bytes))
      return sha256(bytes)
    })
    expect(seen).toHaveLength(1)
    expect(Buffer.from(seen[0]).equals(key)).toBe(true)
  })

  it('returns null wherever the host fingerprint does, and never calls the digest', () => {
    const good = randomBytes(32).toString('base64')
    const rejected = [
      randomBytes(31).toString('base64'),
      randomBytes(33).toString('base64'),
      good.slice(0, 41),
      `${good.slice(0, 10)}!!${good.slice(10)}`,
      ` ${good}`,
      `${good}\n`,
      `${good.replace(/=+$/, '')}===`,
      Buffer.alloc(32, 0xff).toString('base64url'),
      Buffer.alloc(32, 0xfb).toString('base64url'),
      ''
    ]
    for (const text of rejected) {
      expect(fingerprintHostPublicKey(text), JSON.stringify(text)).toBeNull()
      const derived = hostKeyFromPublicKeyB64(text, () => {
        throw new Error(`digest called for ${JSON.stringify(text)}`)
      })
      expect(derived, JSON.stringify(text)).toBeNull()
    }
  })

  it('pins the vector the phone hardcodes (bytes 0x00..0x1f)', () => {
    const vectorBytes = Buffer.from(Array.from({ length: 32 }, (_, index) => index))
    expect(vectorBytes.toString('base64')).toBe(VECTOR_KEY_B64)
    expect(fingerprintHostPublicKey(VECTOR_KEY_B64)).toBe(VECTOR_HOST_KEY)
    expect(hostKeyFromPublicKeyB64(VECTOR_KEY_B64, sha256)).toBe(VECTOR_HOST_KEY)
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
