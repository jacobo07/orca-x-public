const MAC_OCTETS = 6
const MAC_REPETITIONS = 16

// Standard frame (D-06): 6 x 0xFF, then the MAC 16 times.
export const MAGIC_PACKET_BYTES = MAC_OCTETS + MAC_REPETITIONS * MAC_OCTETS

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
