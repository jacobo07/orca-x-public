import { createSocket, type Socket } from 'node:dgram'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startRelayWakeHarness, type RelayWakeHarness } from './wake-broker-relay-test-harness'

// UNIT in-process relay: a loopback relay cell and a real CloudRelayTransport feed a real RuntimeRpcServer.
// Loopback only, never M3 (the live off-LAN leg is OWNER_BOUND).

const SETTLE_MS = 1500

let harness: RelayWakeHarness | null = null
let listener: Socket | null = null

afterEach(async () => {
  vi.restoreAllMocks()
  await harness?.close()
  harness = null
  await new Promise<void>((resolve) => (listener ? listener.close(() => resolve()) : resolve()))
  listener = null
})

async function bindLoopbackListener(frames: Buffer[]): Promise<number> {
  const socket = createSocket({ type: 'udp4' })
  listener = socket
  socket.on('message', (frame) => frames.push(frame))
  await new Promise<void>((resolve) => socket.bind(0, '127.0.0.1', () => resolve()))
  return socket.address().port
}

async function settle(until: () => boolean): Promise<void> {
  const deadline = Date.now() + SETTLE_MS
  while (!until() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

async function openRelayBroker(): Promise<{ host: RelayWakeHarness; frames: Buffer[] }> {
  const frames: Buffer[] = []
  const port = await bindLoopbackListener(frames)
  harness = await startRelayWakeHarness({
    port,
    devices: [
      { name: 'phone-a', grant: true },
      { name: 'phone-b', grant: false }
    ]
  })
  return { host: harness, frames }
}

function stagesOf(reply: Record<string, unknown>): string[] {
  return (reply.result as { stages: { stage: string }[] }).stages.map((s) => s.stage)
}

function expectMagicPacket(frame: Buffer, mac: string): void {
  const macBytes = Buffer.from(mac.replace(/:/g, ''), 'hex')
  expect(frame.length).toBe(102)
  expect([...frame.subarray(0, 6)]).toEqual([0xff, 0xff, 0xff, 0xff, 0xff, 0xff])
  for (let offset = 6; offset < 102; offset += 6) {
    expect(frame.subarray(offset, offset + 6).equals(macBytes)).toBe(true)
  }
}

describe('host.wake.* delivered over the relay transport (UNIT in-process relay)', () => {
  it('a relay-delivered host.wake.request reaches the broker effect and sends one loopback frame', async () => {
    const { host, frames } = await openRelayBroker()
    const phone = await host.openRelayPhone('phone-a')
    await expect(phone.ready).resolves.toBe(true)

    const sent = await phone.call('host.wake.request', {
      targetId: host.targetId,
      requestId: 'relay-req-1'
    })
    expect(sent).toMatchObject({ ok: true })
    expect(stagesOf(sent)).toEqual(['requested', 'authorized', 'packet-sent'])
    await settle(() => frames.length > 1)
    expect(frames).toHaveLength(1)
    expectMagicPacket(frames[0]!, host.targetMac)

    // Why: the host dials the cell; the only mobile socket the server ever saw arrived over the relay.
    expect(host.cellUpgradePaths).toContain(`/v1/host/data/${phone.connId}`)
    expect(host.cellUpgradePaths).toContain(`/v1/connect/${host.relayHostId}`)
    expect(host.server.getMobileSocketWiring()!.connectionCount).toBe(1)
  })
})
