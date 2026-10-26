import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parsePairingCode } from '../../shared/pairing'
import { OrcaRuntimeService } from './orca-runtime'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { decrypt, deriveSharedKey, encrypt, generateKeyPair } from './rpc/e2ee-crypto'
import {
  authenticateMobileWs,
  connectWs,
  nextWsMessage,
  waitForWsClose
} from './runtime-rpc-mobile-ws-test-harness'
import { makeStore } from './runtime-rpc-worktree-store-fixtures'

// Plane: the real RPC server and E2EE handshake over a loopback WebSocket; the phone is scripted.

let server: OrcaRuntimeRpcServer | null = null

afterEach(async () => {
  await server?.stop()
  server = null
})

async function startPairedServer() {
  server = new OrcaRuntimeRpcServer({
    runtime: new OrcaRuntimeService(makeStore() as never),
    userDataPath: mkdtempSync(join(tmpdir(), 'orca-revoked-reason-')),
    enableWebSocket: true,
    wsPort: 0
  })
  await server.start()
  const offer = server.createPairingOffer({ address: '127.0.0.1', name: 'phone', scope: 'mobile' })
  if (!offer.available) {
    throw new Error('WebSocket pairing unavailable')
  }
  return { server, pairingUrl: offer.pairingUrl }
}

/** One handshake with `deviceToken`; returns the decrypted reply to e2ee_auth. */
async function authReply(
  pairingUrl: string,
  deviceToken: string
): Promise<Record<string, unknown>> {
  const parsed = parsePairingCode(pairingUrl)!
  const ws = await connectWs(parsed.endpoint)
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
  expect(JSON.parse(await nextWsMessage(ws))).toEqual({ type: 'e2ee_ready' })
  ws.send(encrypt(JSON.stringify({ type: 'e2ee_auth', deviceToken }), sharedKey))
  const reply = JSON.parse(decrypt(await nextWsMessage(ws), sharedKey)!) as Record<string, unknown>
  ws.close()
  return reply
}

describe('a revoked device is told it was revoked at the handshake', () => {
  it('names device_revoked for a token the desktop revoked', async () => {
    const { server, pairingUrl } = await startPairedServer()
    const live = await authenticateMobileWs(pairingUrl)
    const device = server
      .getDeviceRegistry()!
      .listDevices()
      .find((d) => d.name === 'phone')!

    expect(await server.revokeMobileDevice(device.deviceId)).toBe(true)
    await waitForWsClose(live)

    expect(await authReply(pairingUrl, parsePairingCode(pairingUrl)!.deviceToken)).toEqual({
      type: 'e2ee_error',
      error: { code: 'unauthorized', reason: 'device_revoked' }
    })
  })

  it('keeps the plain refusal for a token the desktop never issued', async () => {
    const { pairingUrl } = await startPairedServer()

    expect(await authReply(pairingUrl, 'never-issued-token')).toEqual({
      type: 'e2ee_error',
      error: { code: 'unauthorized' }
    })
  })
})
