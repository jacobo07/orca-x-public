// Why: the E2EE keypair enables application-layer encryption between mobile
// and desktop over plain ws://. The public key is embedded in the QR pairing
// offer so the mobile client can derive a shared secret via ECDH.
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import nacl from 'tweetnacl'
import { hardenExistingSecureFile, writeDurableSecureJsonFile } from '../../shared/secure-file'
import { E2EE_KEYPAIR_FILENAME } from './mobile-pairing-files'

const KEYPAIR_FILENAME = E2EE_KEYPAIR_FILENAME
const KEYPAIR_VERSION = 1
const MAX_KEYPAIR_FILE_BYTES = 8 * 1024

type KeypairFile = {
  v: number
  publicKeyB64: string
  secretKeyB64: string
}

export type E2EEKeypair = {
  publicKey: Uint8Array
  secretKey: Uint8Array
  publicKeyB64: string
}

/**
 * A key file exists but cannot be used. Minting over it would mint a new host identity —
 * `host-key-fingerprint.ts` derives this host's fleet identity from `sha256(publicKey)` — which
 * silently voids every paired device. Recovery is the Owner's deliberate act, not a side effect
 * of starting up: see `forgetHostIdentity`.
 */
export class E2EEKeypairUnusableError extends Error {
  constructor(readonly keypairPath: string) {
    super(`E2EE keypair at ${keypairPath} exists but is not usable`)
    this.name = 'E2EEKeypairUnusableError'
  }
}

/**
 * A key file that exists but could not be READ — a lock, a permission, an I/O error. Its contents
 * are unknown, not damaged, so the only safe advice is to retry; telling the Owner to re-pair would
 * replace a key that may be perfectly good.
 */
export class E2EEKeypairUnreadableError extends Error {
  constructor(
    readonly keypairPath: string,
    readonly code: string
  ) {
    super(`E2EE keypair at ${keypairPath} could not be read (${code})`)
    this.name = 'E2EEKeypairUnreadableError'
  }
}

type KeypairFileRead =
  | { readonly kind: 'ok'; readonly keypair: E2EEKeypair }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'unreadable'; readonly code: string }

/** Never throws; a read error and invalid contents are different answers. */
function readKeypairFile(filePath: string): KeypairFileRead {
  let text: string
  try {
    // Why: valid keypair files are tiny, so an oversized one is corrupt rather than slow to parse.
    if (statSync(filePath).size > MAX_KEYPAIR_FILE_BYTES) {
      return { kind: 'invalid' }
    }
    text = readFileSync(filePath, 'utf-8')
  } catch (error) {
    return { kind: 'unreadable', code: (error as NodeJS.ErrnoException).code ?? 'UNKNOWN' }
  }
  try {
    const raw: Partial<KeypairFile> = JSON.parse(text)
    if (raw.v !== KEYPAIR_VERSION || typeof raw.publicKeyB64 !== 'string' || !raw.secretKeyB64) {
      return { kind: 'invalid' }
    }
    const publicKey = Uint8Array.from(Buffer.from(raw.publicKeyB64, 'base64'))
    const secretKey = Uint8Array.from(Buffer.from(raw.secretKeyB64, 'base64'))
    if (publicKey.length !== 32 || secretKey.length !== 32) {
      return { kind: 'invalid' }
    }
    return { kind: 'ok', keypair: { publicKey, secretKey, publicKeyB64: raw.publicKeyB64 } }
  } catch {
    return { kind: 'invalid' }
  }
}

/**
 * This host's public key without side effects: `undefined` when no key file exists, `null`
 * when one exists but is not a valid keypair. Observers must use this, never the loader,
 * because the loader hardens the file's ACL and mints one when none exists.
 */
export function readE2EEPublicKey(userDataPath: string): string | null | undefined {
  const filePath = join(userDataPath, KEYPAIR_FILENAME)
  if (!existsSync(filePath)) {
    return undefined
  }
  const read = readKeypairFile(filePath)
  return read.kind === 'ok' ? read.keypair.publicKeyB64 : null
}

/**
 * Discards this host's identity so the next load mints a new one. Every device paired against the
 * old key must be re-paired, so this is only ever called on an explicit Owner action.
 */
export function forgetHostIdentity(userDataPath: string): void {
  rmSync(join(userDataPath, KEYPAIR_FILENAME), { force: true })
}

export function loadOrCreateE2EEKeypair(userDataPath: string): E2EEKeypair {
  const filePath = join(userDataPath, KEYPAIR_FILENAME)

  if (existsSync(filePath)) {
    try {
      hardenExistingSecureFile(filePath)
    } catch {
      // Best effort: a failed ACL tightening must not decide whether the key is readable.
    }
    const loaded = readKeypairFile(filePath)
    if (loaded.kind === 'ok') {
      return loaded.keypair
    }
    if (loaded.kind === 'unreadable') {
      throw new E2EEKeypairUnreadableError(filePath, loaded.code)
    }
    // Why refuse rather than replace: a truncated file is what a half-written key looks like, and
    // regenerating turns a recoverable interruption into a permanent identity fork.
    throw new E2EEKeypairUnusableError(filePath)
  }

  const keypair = nacl.box.keyPair()
  const publicKeyB64 = Buffer.from(keypair.publicKey).toString('base64')
  const secretKeyB64 = Buffer.from(keypair.secretKey).toString('base64')

  const data: KeypairFile = { v: KEYPAIR_VERSION, publicKeyB64, secretKeyB64 }
  // Durable: the fingerprint of this key IS this host's fleet identity, so a rename that outlives
  // its own contents would fork the fleet on the next boot.
  writeDurableSecureJsonFile(filePath, data)

  return { publicKey: keypair.publicKey, secretKey: keypair.secretKey, publicKeyB64 }
}
