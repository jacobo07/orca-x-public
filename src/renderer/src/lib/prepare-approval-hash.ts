import { sha256 } from './sha256'

// Why: unlike the setup-trust digest, the approval names the exact bytes, so nothing is trimmed here.
// crypto.subtle is undefined off a secure context (LAN web client); the fallback yields the same SHA-256.
export async function rendererPrepareSha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = (globalThis.crypto as Crypto | undefined)?.subtle as SubtleCrypto | undefined
  const digest = subtle
    ? new Uint8Array(await subtle.digest('SHA-256', bytes as BufferSource))
    : sha256(bytes)
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')
}
