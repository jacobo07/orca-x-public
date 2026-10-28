import { randomBytes } from 'node:crypto'
import type WebSocket from 'ws'
import { WebSocketServer } from 'ws'

// Test-only relay cell on 127.0.0.1: splices a host data leg to a phone leg by connId, like the cloud cell.

type CellLeg = { host: WebSocket | null; phone: WebSocket | null }

export type LoopbackRelayCell = {
  origin: string
  upgradePaths: string[]
  expectLeg(connId: string): { connTicket: string; credential: string }
  close(): Promise<void>
}

export function parseJsonObject(text: string | null): Record<string, unknown> | null {
  if (text === null) {
    return null
  }
  try {
    const value: unknown = JSON.parse(text)
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
  } catch {
    // Why null: a non-JSON frame is a protocol refusal the caller turns into close or not-ready.
    return null
  }
}

function pipe(from: WebSocket, to: WebSocket): void {
  from.on('message', (raw, isBinary) => {
    if (to.readyState === to.OPEN) {
      to.send(raw, { binary: isBinary })
    }
  })
  from.once('close', () => to.close())
}

function decodeConnId(encoded: string): string | null {
  try {
    return decodeURIComponent(encoded)
  } catch {
    // Why null: a malformed path is a refused leg, never a throw from the message listener.
    return null
  }
}

function listening(cell: WebSocketServer): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      cell.off('listening', onListening)
      reject(error)
    }
    const onListening = (): void => {
      cell.off('error', onError)
      resolve()
    }
    cell.once('error', onError)
    cell.once('listening', onListening)
  })
}

// Splices the host's /v1/host/data/<connId> leg to the phone leg whose relay credential names that connId.
export async function startLoopbackRelayCell(
  relayHostId: string,
  options: { port?: number } = {}
): Promise<LoopbackRelayCell> {
  const cell = new WebSocketServer({
    host: '127.0.0.1',
    port: options.port ?? 0,
    perMessageDeflate: false
  })
  await listening(cell)
  const address = cell.address()
  if (!address || typeof address === 'string') {
    throw new Error('relay cell has no TCP address')
  }
  const upgradePaths: string[] = []
  const tickets = new Map<string, string>()
  const credentials = new Map<string, string>()
  const legs = new Map<string, CellLeg>()
  const attachLeg = (connId: string, side: keyof CellLeg, socket: WebSocket): void => {
    const leg = legs.get(connId) ?? { host: null, phone: null }
    leg[side] = socket
    legs.set(connId, leg)
    if (leg.host && leg.phone) {
      pipe(leg.host, leg.phone)
      pipe(leg.phone, leg.host)
      leg.phone.send(JSON.stringify({ type: 'relay-hello', ok: true, credentialKind: 'invite' }))
    }
  }
  const admit = (path: string, auth: Record<string, unknown> | null, socket: WebSocket): void => {
    if (path.startsWith('/v1/host/data/')) {
      const connId = decodeConnId(path.slice('/v1/host/data/'.length))
      const ticket = connId === null ? undefined : tickets.get(connId)
      // Why both typed: undefined === undefined would admit an unregistered connId with no ticket.
      if (
        connId !== null &&
        auth?.type === 'host-data-auth' &&
        typeof ticket === 'string' &&
        typeof auth.connTicket === 'string' &&
        auth.connTicket === ticket
      ) {
        attachLeg(connId, 'host', socket)
        return
      }
    } else if (path === `/v1/connect/${relayHostId}` && auth?.type === 'relay-auth') {
      const connId = credentials.get(String(auth.credential))
      if (connId) {
        attachLeg(connId, 'phone', socket)
        return
      }
    }
    socket.close(4003, 'relay cell refused the leg')
  }
  cell.on('connection', (socket, request) => {
    const path = request.url ?? ''
    upgradePaths.push(path)
    socket.on('error', () => socket.terminate())
    socket.once('message', (raw) => admit(path, parseJsonObject(raw.toString()), socket))
  })
  return {
    origin: `http://127.0.0.1:${address.port}`,
    upgradePaths,
    expectLeg(connId) {
      const connTicket = randomBytes(32).toString('base64url')
      const credential = randomBytes(32).toString('base64url')
      tickets.set(connId, connTicket)
      credentials.set(credential, connId)
      return { connTicket, credential }
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of cell.clients) {
          client.terminate()
        }
        cell.close(() => resolve())
      })
  }
}
