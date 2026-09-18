// Why: the E2EE keypair enables application-layer encryption between mobile
// and desktop over plain ws://. The public key is embedded in the QR pairing
// offer so the mobile client can derive a shared secret via ECDH.
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import nacl from 'tweetnacl'
import { hardenExistingSecureFile, writeSecureJsonFile } from '../../shared/secure-file'
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
 * This host's public key without side effects: `undefined` when no key file exists, `null`
 * when one exists but is not a valid keypair. Observers must use this, never the loader,
 * because the loader replaces a malformed file and so changes the host's identity.
 */
export function readE2EEPublicKey(userDataPath: string): string | null | undefined {
  const filePath = join(userDataPath, KEYPAIR_FILENAME)
  if (!existsSync(filePath)) {
    return undefined
  }
  try {
    if (statSync(filePath).size > MAX_KEYPAIR_FILE_BYTES) {
      return null
    }
    const raw: Partial<KeypairFile> = JSON.parse(readFileSync(filePath, 'utf-8'))
    if (raw.v !== KEYPAIR_VERSION || typeof raw.publicKeyB64 !== 'string' || !raw.secretKeyB64) {
      return null
    }
    return Buffer.from(raw.publicKeyB64, 'base64').length === 32 ? raw.publicKeyB64 : null
  } catch {
    return null
  }
}

export function loadOrCreateE2EEKeypair(userDataPath: string): E2EEKeypair {
  const filePath = join(userDataPath, KEYPAIR_FILENAME)

  if (existsSync(filePath)) {
    try {
      hardenExistingSecureFile(filePath)
      // Why: this startup path reads synchronously; valid keypair files are
      // tiny, so oversized/corrupt files should be replaced without loading.
      if (statSync(filePath).size > MAX_KEYPAIR_FILE_BYTES) {
        throw new Error('E2EE keypair file is too large')
      }
      const raw: KeypairFile = JSON.parse(readFileSync(filePath, 'utf-8'))
      if (raw.v === KEYPAIR_VERSION && raw.publicKeyB64 && raw.secretKeyB64) {
        const publicKey = Uint8Array.from(Buffer.from(raw.publicKeyB64, 'base64'))
        const secretKey = Uint8Array.from(Buffer.from(raw.secretKeyB64, 'base64'))
        if (publicKey.length === 32 && secretKey.length === 32) {
          return { publicKey, secretKey, publicKeyB64: raw.publicKeyB64 }
        }
      }
    } catch {
      // Malformed file — regenerate below.
    }
  }

  const keypair = nacl.box.keyPair()
  const publicKeyB64 = Buffer.from(keypair.publicKey).toString('base64')
  const secretKeyB64 = Buffer.from(keypair.secretKey).toString('base64')

  const data: KeypairFile = { v: KEYPAIR_VERSION, publicKeyB64, secretKeyB64 }
  writeSecureJsonFile(filePath, data)

  return { publicKey: keypair.publicKey, secretKey: keypair.secretKey, publicKeyB64 }
}
