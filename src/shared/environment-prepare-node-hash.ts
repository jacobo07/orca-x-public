import { createHash } from 'node:crypto'

// Imported only by main and CLI code; the renderer has its own Web Crypto digest.
export async function nodePrepareSha256Hex(bytes: Uint8Array): Promise<string> {
  return createHash('sha256').update(bytes).digest('hex')
}
