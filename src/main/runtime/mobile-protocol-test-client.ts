import WebSocket from 'ws'
import { parsePairingCode } from '../../shared/pairing'
import { decrypt, deriveSharedKey, encrypt, generateKeyPair } from './rpc/e2ee-crypto'

/** A scripted phone: the mobile app's E2EE handshake and encrypted JSON-RPC, nothing else. */
export type MobileProtocolClient = {
  call: (method: string, params?: unknown) => Promise<Record<string, unknown>>
  close: () => Promise<void>
}

function nextMessage(ws: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    ws.once('message', (data) => resolve(data.toString('utf-8')))
    ws.once('close', (code) => reject(new Error(`socket closed ${code} during handshake`)))
  })
}

export async function connectMobileProtocolClient(
  pairingUrl: string
): Promise<MobileProtocolClient> {
  const parsed = parsePairingCode(pairingUrl)
  if (!parsed) {
    throw new Error('pairing URL did not parse')
  }
  const ws = await new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(parsed.endpoint)
    socket.once('open', () => resolve(socket))
    socket.once('error', reject)
  })
  const keys = generateKeyPair()
  const sharedKey = deriveSharedKey(
    keys.secretKey,
    Uint8Array.from(Buffer.from(parsed.publicKeyB64, 'base64'))
  )
  ws.send(
    JSON.stringify({
      type: 'e2ee_hello',
      publicKeyB64: Buffer.from(keys.publicKey).toString('base64')
    })
  )
  const ready = JSON.parse(await nextMessage(ws)) as { type?: string }
  if (ready.type !== 'e2ee_ready') {
    throw new Error(`unexpected handshake reply ${JSON.stringify(ready)}`)
  }
  ws.send(
    encrypt(JSON.stringify({ type: 'e2ee_auth', deviceToken: parsed.deviceToken }), sharedKey)
  )
  const authed = JSON.parse(decrypt(await nextMessage(ws), sharedKey) ?? '{}') as { type?: string }
  if (authed.type !== 'e2ee_authenticated') {
    throw new Error(`device was not authenticated: ${JSON.stringify(authed)}`)
  }

  const waiters = new Map<string, (response: Record<string, unknown>) => void>()
  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      return
    }
    const plaintext = decrypt(data.toString('utf-8'), sharedKey)
    if (plaintext === null) {
      return
    }
    const response = JSON.parse(plaintext) as Record<string, unknown>
    const id = typeof response.id === 'string' ? response.id : ''
    waiters.get(id)?.(response)
    waiters.delete(id)
  })
  let seq = 0
  return {
    call: (method, params = {}) =>
      new Promise((resolve) => {
        const id = `phone-${++seq}`
        waiters.set(id, resolve)
        ws.send(encrypt(JSON.stringify({ id, method, params }), sharedKey))
      }),
    close: () =>
      new Promise((resolve) => {
        if (ws.readyState === ws.CLOSED) {
          resolve()
          return
        }
        ws.once('close', () => resolve())
        ws.close()
      })
  }
}
