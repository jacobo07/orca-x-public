import { createHash } from 'node:crypto'

const HOST_PUBLIC_KEY_BYTES = 32

export function fingerprintHostKeyBytes(publicKey: Uint8Array): string {
  return createHash('sha256').update(publicKey).digest('base64url')
}

/** `null` unless the text decodes to exactly one curve25519 public key. */
export function fingerprintHostPublicKey(publicKeyB64: string): string | null {
  // Why: Node's base64 decoder skips junk, so a garbled key would otherwise hash to a stable id.
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(publicKeyB64)) {
    return null
  }
  const bytes = Buffer.from(publicKeyB64, 'base64')
  return bytes.length === HOST_PUBLIC_KEY_BYTES ? fingerprintHostKeyBytes(bytes) : null
}
