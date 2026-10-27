import { createSocket, type Socket } from 'node:dgram'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildMagicPacket,
  MAGIC_PACKET_BYTES,
  normalizeMac,
  sendMagicPacketUdp
} from './wake-magic-packet'

const MAC = 'aa:bb:cc:dd:ee:ff'

function framesMac(frame: Buffer, mac: string): boolean {
  const macBytes = Buffer.from(mac.replace(/:/g, ''), 'hex')
  if (frame.length !== MAGIC_PACKET_BYTES || !frame.subarray(0, 6).equals(Buffer.alloc(6, 0xff))) {
    return false
  }
  for (let i = 0; i < 16; i++) {
    if (!frame.subarray(6 + i * 6, 12 + i * 6).equals(macBytes)) {
      return false
    }
  }
  return true
}

describe('magic packet frame', () => {
  it('is 6 x 0xFF then the MAC 16 times, 102 bytes', () => {
    const frame = buildMagicPacket(MAC)
    expect(MAGIC_PACKET_BYTES).toBe(102)
    expect(frame.length).toBe(102)
    expect([...frame.subarray(0, 6)]).toEqual([0xff, 0xff, 0xff, 0xff, 0xff, 0xff])
    expect(framesMac(frame, MAC)).toBe(true)
  })

  it('normalizes colon, dash and mixed case to lowercase colon form', () => {
    expect(normalizeMac('AA:BB:CC:DD:EE:FF')).toBe(MAC)
    expect(normalizeMac('aa-bb-cc-dd-ee-ff')).toBe(MAC)
    expect(normalizeMac('Aa-bB:cC-Dd:eE-fF')).toBe(MAC)
  })

  it('rejects 5 or 7 octets and non-hex', () => {
    expect(normalizeMac('aa:bb:cc:dd:ee')).toBeNull()
    expect(normalizeMac('aa:bb:cc:dd:ee:ff:00')).toBeNull()
    expect(normalizeMac('aa:bb:cc:dd:ee:gg')).toBeNull()
    expect(normalizeMac('')).toBeNull()
  })
})

describe('sendMagicPacketUdp over loopback', () => {
  let listener: Socket | null = null

  afterEach(async () => {
    const socket = listener
    listener = null
    if (socket) {
      await new Promise<void>((resolve) => socket.close(() => resolve()))
    }
  })

  async function capture(): Promise<{ port: number; messages: Buffer[] }> {
    const socket = createSocket({ type: 'udp4' })
    listener = socket
    const messages: Buffer[] = []
    socket.on('message', (msg) => messages.push(msg))
    await new Promise<void>((resolve) => socket.bind(0, '127.0.0.1', () => resolve()))
    return { port: socket.address().port, messages }
  }

  async function waitForMessages(messages: Buffer[], count: number): Promise<void> {
    for (let i = 0; i < 100 && messages.length < count; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve))
      await new Promise<void>((resolve) => setTimeout(resolve, 5))
    }
  }

  it('positive control: a real listener captures exactly one 102-byte frame for the MAC', async () => {
    const { port, messages } = await capture()
    await sendMagicPacketUdp(buildMagicPacket(MAC), '127.0.0.1', port)
    await waitForMessages(messages, 1)
    await new Promise<void>((resolve) => setTimeout(resolve, 50))
    expect(messages).toHaveLength(1)
    expect(messages[0].length).toBe(102)
    expect(framesMac(messages[0], MAC)).toBe(true)
  })

  it('negative control: the same capture does not match a different MAC', async () => {
    const { port, messages } = await capture()
    await sendMagicPacketUdp(buildMagicPacket(MAC), '127.0.0.1', port)
    await waitForMessages(messages, 1)
    expect(messages).toHaveLength(1)
    expect(framesMac(messages[0], 'aa:bb:cc:dd:ee:fe')).toBe(false)
  })

  it('rejects, never resolves, when the send itself throws', async () => {
    await expect(
      sendMagicPacketUdp(buildMagicPacket(MAC), '127.0.0.1', 70_000)
    ).rejects.toBeInstanceOf(Error)
  })
})
