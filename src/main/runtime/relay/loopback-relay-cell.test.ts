import { createServer, type Server } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { startLoopbackRelayCell, type LoopbackRelayCell } from './loopback-relay-cell'

const REFUSED = 4003
const opened: { cell: LoopbackRelayCell | null; blocker: Server | null } = {
  cell: null,
  blocker: null
}

afterEach(async () => {
  await opened.cell?.close()
  await new Promise<void>((resolve) =>
    opened.blocker ? opened.blocker.close(() => resolve()) : resolve()
  )
  opened.cell = null
  opened.blocker = null
})

function wsOrigin(cell: LoopbackRelayCell): string {
  return cell.origin.replace(/^http:/, 'ws:')
}

// Why a close code: the cell answers every refused leg by closing it with 4003.
function sendFirstFrameAndAwaitClose(url: string, frame: Record<string, unknown>): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    socket.once('open', () => socket.send(JSON.stringify(frame)))
    socket.once('close', (code) => resolve(code))
    socket.once('error', reject)
  })
}

describe('loopback relay cell admission (IN-03)', () => {
  it('refuses a host leg for an unregistered connId that sends no ticket', async () => {
    opened.cell = await startLoopbackRelayCell('relay-host')
    const code = await sendFirstFrameAndAwaitClose(`${wsOrigin(opened.cell)}/v1/host/data/ghost`, {
      type: 'host-data-auth'
    })
    expect(code).toBe(REFUSED)
  }, 2_000)

  it('refuses a host leg whose path is malformed instead of throwing from the listener', async () => {
    opened.cell = await startLoopbackRelayCell('relay-host')
    const { connTicket } = opened.cell.expectLeg('c1')
    const code = await sendFirstFrameAndAwaitClose(
      `${wsOrigin(opened.cell)}/v1/host/data/%E0%A4%A`,
      {
        type: 'host-data-auth',
        connTicket
      }
    )
    expect(code).toBe(REFUSED)
  }, 2_000)

  it('still admits a registered host leg with its ticket (control)', async () => {
    opened.cell = await startLoopbackRelayCell('relay-host')
    const { connTicket, credential } = opened.cell.expectLeg('c1')
    const host = new WebSocket(`${wsOrigin(opened.cell)}/v1/host/data/c1`)
    await new Promise<void>((resolve) => host.once('open', () => resolve()))
    host.send(JSON.stringify({ type: 'host-data-auth', connTicket }))
    const phone = new WebSocket(`${wsOrigin(opened.cell)}/v1/connect/relay-host`)
    const hello = new Promise<string>((resolve) =>
      phone.once('message', (raw) => resolve(String(raw)))
    )
    phone.once('open', () => phone.send(JSON.stringify({ type: 'relay-auth', credential })))
    expect(JSON.parse(await hello)).toMatchObject({ type: 'relay-hello', ok: true })
    host.terminate()
    phone.terminate()
  }, 2_000)

  it('rejects instead of crashing when the listen fails', async () => {
    const blocker = createServer()
    opened.blocker = blocker
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', () => resolve()))
    const address = blocker.address()
    if (!address || typeof address === 'string') {
      throw new Error('blocker has no TCP address')
    }
    await expect(startLoopbackRelayCell('relay-host', { port: address.port })).rejects.toThrow(
      /EADDRINUSE/
    )
  }, 2_000)
})
