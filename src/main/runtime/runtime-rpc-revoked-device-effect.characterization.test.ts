import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { readRuntimeMetadata } from './runtime-metadata'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { decrypt, encryptBytes } from './rpc/e2ee-crypto'
import {
  TerminalStreamOpcode,
  encodeTerminalStreamFrame,
  encodeTerminalStreamJson,
  encodeTerminalStreamText
} from '../../shared/terminal-stream-protocol'
import { sendRequest } from './runtime-rpc-test-harness'
import {
  authenticateMobileWsSession,
  sendEncryptedWsRequest
} from './runtime-rpc-mobile-ws-test-harness'
import { makeStore } from './runtime-rpc-worktree-store-fixtures'

vi.mock('../git/worktree', () => {
  const worktrees = [
    {
      path: '/tmp/worktree-a',
      head: 'abc',
      branch: 'feature/foo',
      isBare: false,
      isMainWorktree: false
    }
  ]
  return {
    listWorktrees: vi.fn().mockResolvedValue(worktrees),
    listWorktreesStrict: vi.fn().mockResolvedValue(worktrees)
  }
})

const STREAM_ID = 31

// Why: the shared reader decrypts every frame as text, and an open stream also delivers binary output frames.
function createTextResponseReader(
  session: Awaited<ReturnType<typeof authenticateMobileWsSession>>
): {
  next: (
    id: string,
    predicate?: (response: Record<string, unknown>) => boolean
  ) => Promise<Record<string, unknown>>
} {
  const queue: Record<string, unknown>[] = []
  const waiters: {
    id: string
    predicate: (r: Record<string, unknown>) => boolean
    resolve: (r: Record<string, unknown>) => void
  }[] = []
  session.ws.on('message', (data, isBinary) => {
    if (isBinary) {
      return
    }
    const plaintext = decrypt(data.toString('utf-8'), session.sharedKey)
    if (plaintext === null) {
      return
    }
    const response = JSON.parse(plaintext) as Record<string, unknown>
    const index = waiters.findIndex((w) => w.id === response.id && w.predicate(response))
    if (index === -1) {
      queue.push(response)
      return
    }
    waiters.splice(index, 1)[0]!.resolve(response)
  })
  return {
    next: (id, predicate = () => true) => {
      const queued = queue.findIndex((r) => r.id === id && predicate(r))
      if (queued !== -1) {
        return Promise.resolve(queue.splice(queued, 1)[0]!)
      }
      return new Promise((resolve) => waiters.push({ id, predicate, resolve }))
    }
  }
}

async function openRevokedRuntimeSession(): Promise<{
  server: OrcaRuntimeRpcServer
  session: Awaited<ReturnType<typeof authenticateMobileWsSession>>
  responses: ReturnType<typeof createTextResponseReader>
  writes: { terminal: string; text: string }[]
  deviceToken: string
  deviceId: string
}> {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
  const writes: { terminal: string; text: string }[] = []
  const runtime = new OrcaRuntimeService(makeStore() as never)
  runtime.setPtyController({
    spawn: vi.fn().mockResolvedValue({ id: 'revoked-effect-pty' }),
    write: (ptyId, data) => {
      writes.push({ terminal: ptyId, text: data })
      return true
    },
    kill: () => true,
    getForegroundProcess: async () => null
  })
  const server = new OrcaRuntimeRpcServer({
    runtime,
    userDataPath,
    enableWebSocket: true,
    wsPort: 0
  })
  await server.start()
  const offer = server.createPairingOffer({
    address: '127.0.0.1',
    name: 'runtime-grant',
    scope: 'runtime'
  })
  if (!offer.available) {
    throw new Error('WebSocket pairing unavailable')
  }
  const metadata = readRuntimeMetadata(userDataPath)
  const created = await sendRequest(metadata!.transports[0]!.endpoint, {
    id: 'laptop_create',
    authToken: metadata!.authToken,
    method: 'terminal.create',
    params: {
      worktree: 'id:repo-1::/tmp/worktree-a',
      command: 'revoked-effect',
      tabId: 'revoked-effect-tab',
      leafId: '33333333-3333-4333-8333-333333333333',
      activate: true
    }
  })
  const terminal = (created.result as { terminal: { handle: string } }).terminal

  const session = await authenticateMobileWsSession(offer.pairingUrl)
  const responses = createTextResponseReader(session)
  sendEncryptedWsRequest(session, { id: 'mux', method: 'terminal.multiplex', params: {} })
  await responses.next('mux', (r) => (r.result as { type?: string })?.type === 'ready')
  session.ws.send(
    Buffer.from(
      encryptBytes(
        encodeTerminalStreamFrame({
          seq: 1,
          opcode: TerminalStreamOpcode.Subscribe,
          streamId: 0,
          payload: encodeTerminalStreamJson({
            streamId: STREAM_ID,
            terminal: terminal.handle,
            client: { id: 'runtime-grant', type: 'desktop' },
            capabilities: { ackOutput: 1 }
          })
        }),
        session.sharedKey
      )
    ),
    { binary: true }
  )
  await responses.next(
    'mux',
    (r) => (r.result as { type?: string; streamId?: number })?.type === 'subscribed'
  )

  // Why: D-18 — the live-connection kill can miss (relay-bound socket, failed close); correctness must not need it.
  vi.spyOn(server['mobileSocketWiring']!, 'terminateDeviceConnections').mockReturnValue(0)
  const deviceToken = server.getDeviceRegistry()!.getDevice(offer.deviceId)!.token
  if (deviceToken === undefined) {
    throw new Error('an authenticated device must carry its token in memory')
  }
  return { server, session, responses, writes, deviceToken, deviceId: offer.deviceId }
}

function sendInputFrame(
  session: Awaited<ReturnType<typeof authenticateMobileWsSession>>,
  text: string
): void {
  session.ws.send(
    Buffer.from(
      encryptBytes(
        encodeTerminalStreamFrame({
          seq: 2,
          opcode: TerminalStreamOpcode.Input,
          streamId: STREAM_ID,
          payload: encodeTerminalStreamText(text)
        }),
        session.sharedKey
      )
    ),
    { binary: true }
  )
}

describe('revoked device whose socket survived the kill (row 58; characterization inverted in 14-02 Task 1)', () => {
  it('V-REV-TEXT-REFUSED: a JSON-RPC request on the surviving socket is refused as unauthorized', async () => {
    const { server, session, responses } = await openRevokedRuntimeSession()
    try {
      const offer = server.getDeviceRegistry()!.listDevices()[0]!
      expect(server.revokeRuntimeAccess(offer.deviceId)).toBe(true)
      expect(session.ws.readyState).toBe(session.ws.OPEN)

      sendEncryptedWsRequest(session, { id: 'after_revoke', method: 'status.get' })
      const reply = await responses.next('after_revoke')
      expect(reply).toMatchObject({ ok: false, error: { code: 'unauthorized' } })
    } finally {
      session.ws.close()
      await server.stop()
    }
  })

  it('V-REV-WIRE-CODE: the code stays the one old clients fail closed on; the reason rides only in data', async () => {
    const { server, session, responses } = await openRevokedRuntimeSession()
    try {
      const offer = server.getDeviceRegistry()!.listDevices()[0]!
      expect(server.revokeRuntimeAccess(offer.deviceId)).toBe(true)

      sendEncryptedWsRequest(session, { id: 'wire_code', method: 'status.get' })
      const reply = await responses.next('wire_code')
      const error = reply.error as { code: string; data?: unknown }
      expect(error.code).toBe('unauthorized')
      expect(error.data).toEqual({ reason: 'device_revoked' })
    } finally {
      session.ws.close()
      await server.stop()
    }
  })

  it('V-REV-BINARY-REFUSED: a terminal input frame on the open stream is NOT delivered and the socket closes 4001 Unauthorized', async () => {
    const { server, session, writes } = await openRevokedRuntimeSession()
    try {
      const closeInfo = new Promise<{ code: number; reason: string }>((resolve) => {
        session.ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() }))
      })
      const offer = server.getDeviceRegistry()!.listDevices()[0]!
      expect(server.revokeRuntimeAccess(offer.deviceId)).toBe(true)
      expect(session.ws.readyState).toBe(session.ws.OPEN)

      sendInputFrame(session, 'rm -rf everything\r')
      // Why: the close is the positive signal that the frame was judged; without it "not written" could mean "not yet".
      await expect(closeInfo).resolves.toEqual({ code: 4001, reason: 'Unauthorized' })
      expect(writes).not.toContainEqual({
        terminal: 'revoked-effect-pty',
        text: 'rm -rf everything\r'
      })
    } finally {
      session.ws.close()
      await server.stop()
    }
  })

  it('control: a still-authorized device input frame on the same stream IS delivered', async () => {
    const { server, session, writes } = await openRevokedRuntimeSession()
    try {
      sendInputFrame(session, 'still authorized\r')
      await vi.waitFor(
        () =>
          expect(writes).toContainEqual({
            terminal: 'revoked-effect-pty',
            text: 'still authorized\r'
          }),
        { timeout: 60_000, interval: 25 }
      )
    } finally {
      session.ws.close()
      await server.stop()
    }
  })
})
