// Why: separate from rpc-client-unauthorized-close.test.ts — a revocation the desktop names is definitive,
// unlike the transient unauthorized (issue #5200) that the retry budget exists for.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connect } from './rpc-client'

vi.mock('./e2ee', () => ({
  generateKeyPair: () => ({
    publicKey: new Uint8Array(32),
    secretKey: new Uint8Array(32)
  }),
  deriveSharedKey: () => new Uint8Array(32),
  publicKeyFromBase64: () => new Uint8Array(32),
  publicKeyToBase64: () => 'client-public-key',
  encrypt: (plaintext: string) => `encrypted:${plaintext}`,
  decrypt: (raw: string) => raw.replace(/^encrypted:/, ''),
  decryptBytes: (bytes: Uint8Array) => bytes
}))

class MockWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3

  readonly CONNECTING = MockWebSocket.CONNECTING
  readonly OPEN = MockWebSocket.OPEN
  readonly CLOSING = MockWebSocket.CLOSING
  readonly CLOSED = MockWebSocket.CLOSED

  readyState = MockWebSocket.CONNECTING
  onopen: (() => void) | null = null
  onclose: ((event?: { code?: number; reason?: string; wasClean?: boolean }) => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: (() => void) | null = null
  sent: string[] = []
  close = vi.fn(() => {
    if (this.readyState === MockWebSocket.CLOSED) {
      return
    }
    this.readyState = MockWebSocket.CLOSED
    this.onclose?.()
  })

  constructor(readonly endpoint: string) {
    mockSockets.push(this)
  }

  send(payload: string): void {
    this.sent.push(payload)
  }

  open(): void {
    this.readyState = MockWebSocket.OPEN
    this.onopen?.()
  }

  receive(payload: unknown): void {
    this.onmessage?.({ data: payload })
  }
}

const mockSockets: MockWebSocket[] = []
const originalWebSocket = globalThis.WebSocket

function handshake(socket: MockWebSocket): void {
  socket.open()
  socket.receive(JSON.stringify({ type: 'e2ee_ready' }))
}

describe('a revocation the desktop names', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mockSockets.length = 0
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket
  })

  afterEach(() => {
    vi.useRealTimers()
    globalThis.WebSocket = originalWebSocket
  })

  it('latches auth-failed on the first handshake refusal with reason device_revoked', async () => {
    const client = connect('ws://desktop.invalid', 'token', 'server-key')
    handshake(mockSockets[0]!)
    mockSockets[0]!.receive(
      'encrypted:{"type":"e2ee_error","error":{"code":"unauthorized","reason":"device_revoked"}}'
    )

    expect(client.getState()).toBe('auth-failed')
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(mockSockets).toHaveLength(1)

    client.close()
  })

  it('latches auth-failed on a mid-session refusal carrying data.reason device_revoked', async () => {
    const client = connect('ws://desktop.invalid', 'token', 'server-key')
    const socket = mockSockets[0]!
    handshake(socket)
    socket.receive('encrypted:{"type":"e2ee_authenticated"}')
    expect(client.getState()).toBe('connected')

    const pending = client.sendRequest('terminal.send', { terminal: 'term_1', text: 'x' })
    const request = JSON.parse(socket.sent.at(-1)!.replace(/^encrypted:/, '')) as { id: string }
    socket.receive(
      `encrypted:${JSON.stringify({
        id: request.id,
        ok: false,
        error: {
          code: 'unauthorized',
          message: 'Device access revoked',
          data: { reason: 'device_revoked' }
        }
      })}`
    )

    await expect(pending).rejects.toThrow(/revoked/i)
    expect(client.getState()).toBe('auth-failed')
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(mockSockets).toHaveLength(1)

    client.close()
  })

  it('still retries an unauthorized refusal that names no reason (old desktops, transient #5200)', () => {
    const client = connect('ws://desktop.invalid', 'token', 'server-key')
    handshake(mockSockets[0]!)
    mockSockets[0]!.receive('encrypted:{"type":"e2ee_error","error":{"code":"unauthorized"}}')

    expect(client.getState()).toBe('reconnecting')

    client.close()
  })
})
