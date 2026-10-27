import { createSocket } from 'node:dgram'

const MAC_OCTETS = 6
const MAC_REPETITIONS = 16
const MAC_FORM = /^[0-9a-f]{2}([:-][0-9a-f]{2}){5}$/i

// Standard frame (D-06): 6 x 0xFF, then the MAC 16 times.
export const MAGIC_PACKET_BYTES = MAC_OCTETS + MAC_REPETITIONS * MAC_OCTETS

export function normalizeMac(input: string): string | null {
  const trimmed = input.trim()
  return MAC_FORM.test(trimmed) ? trimmed.toLowerCase().replace(/-/g, ':') : null
}

export function buildMagicPacket(mac: string): Buffer {
  const macBytes = Buffer.from(mac.replace(/[:-]/g, ''), 'hex')
  if (macBytes.length !== MAC_OCTETS) {
    throw new Error('invalid_mac')
  }
  const frame = Buffer.alloc(MAGIC_PACKET_BYTES, 0xff)
  for (let i = 0; i < MAC_REPETITIONS; i++) {
    macBytes.copy(frame, MAC_OCTETS + i * MAC_OCTETS)
  }
  return frame
}

// Why resolve only in the send callback: that callback is the packet-sent evidence (D-11).
export function sendMagicPacketUdp(frame: Buffer, address: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createSocket({ type: 'udp4' })
    let settled = false
    const finish = (error: Error | null): void => {
      if (settled) {
        return
      }
      settled = true
      socket.close()
      if (error) {
        reject(error)
      } else {
        resolve()
      }
    }
    socket.on('error', (error) => finish(error))
    socket.bind(0, () => {
      try {
        // Why inside the bind callback: setBroadcast throws on an unbound socket.
        socket.setBroadcast(true)
        socket.send(frame, port, address, (error) => finish(error ?? null))
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)))
      }
    })
  })
}
