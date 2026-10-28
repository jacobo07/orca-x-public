import { createSocket, type Socket } from 'node:dgram'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { wakeBrokerHost } from './wake-broker-host'
import { startRelayWakeHarness, type RelayWakeHarness } from './wake-broker-relay-test-harness'
import { loadWakeBrokerStore } from './wake-broker-store'

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

const MAC_SHAPE = /([0-9a-f]{2}[:-]){5}[0-9a-f]{2}/i

function stagesOf(reply: Record<string, unknown>): string[] {
  return (reply.result as { stages: { stage: string }[] }).stages.map((s) => s.stage)
}

function wakeIdOf(reply: Record<string, unknown>): string {
  return (reply.result as { wakeId: string }).wakeId
}

function deviceNamed(host: RelayWakeHarness, name: string): { deviceId: string } {
  const device = host.devices.find((d) => d.name === name)
  if (!device) {
    throw new Error(`harness has no device ${name}`)
  }
  return device
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

  it('replays the same requestId over the relay: same wakeId, replayed true, +0 frames', async () => {
    const { host, frames } = await openRelayBroker()
    const phone = await host.openRelayPhone('phone-a')
    await expect(phone.ready).resolves.toBe(true)
    const params = { targetId: host.targetId, requestId: 'relay-req-1' }

    const first = await phone.call('host.wake.request', params)
    const replay = await phone.call('host.wake.request', params)
    expect(first).toMatchObject({ ok: true, result: { replayed: false } })
    expect(replay).toMatchObject({
      ok: true,
      result: { wakeId: wakeIdOf(first), replayed: true }
    })
    await settle(() => frames.length > 1)
    expect(frames).toHaveLength(1)
  })

  it('status ends at packet-sent, targets lists only the granted target, and no reply carries a MAC', async () => {
    const { host, frames } = await openRelayBroker()
    const phone = await host.openRelayPhone('phone-a')
    await expect(phone.ready).resolves.toBe(true)

    const sent = await phone.call('host.wake.request', {
      targetId: host.targetId,
      requestId: 'relay-req-1'
    })
    const status = await phone.call('host.wake.status', { wakeId: wakeIdOf(sent) })
    expect(status).toMatchObject({ ok: true })
    expect(stagesOf(status).at(-1)).toBe('packet-sent')
    const targets = await phone.call('host.wake.targets', {})
    expect((targets.result as { targets: unknown }).targets).toEqual([
      { targetId: host.targetId, label: host.targetLabel }
    ])

    // Why the positive control: a scan that cannot match the real MAC proves nothing about its absence.
    expect(MAC_SHAPE.test(host.targetMac)).toBe(true)
    for (const reply of [sent, status, targets]) {
      expect(JSON.stringify(reply)).not.toMatch(MAC_SHAPE)
    }
    await settle(() => frames.length > 1)
    expect(frames).toHaveLength(1)
  })

  it('refuses an ungranted device over the relay with wake_grant_missing and lists no targets', async () => {
    const { host, frames } = await openRelayBroker()
    const phone = await host.openRelayPhone('phone-b')
    await expect(phone.ready).resolves.toBe(true)

    const refused = await phone.call('host.wake.request', {
      targetId: host.targetId,
      requestId: 'relay-req-ungranted'
    })
    expect(refused).toMatchObject({ ok: false, error: { code: 'wake_grant_missing' } })
    const targets = await phone.call('host.wake.targets', {})
    expect(targets).toMatchObject({ ok: true, result: { targets: [] } })
    for (const reply of [refused, targets]) {
      expect(JSON.stringify(reply)).not.toMatch(MAC_SHAPE)
    }
    await settle(() => frames.length > 0)
    expect(frames).toHaveLength(0)
  })

  it("hides another device's wake from host.wake.status over the relay (wake_unknown)", async () => {
    const { host, frames } = await openRelayBroker()
    const phoneA = await host.openRelayPhone('phone-a')
    const phoneB = await host.openRelayPhone('phone-b')
    await expect(phoneA.ready).resolves.toBe(true)
    await expect(phoneB.ready).resolves.toBe(true)

    const sent = await phoneA.call('host.wake.request', {
      targetId: host.targetId,
      requestId: 'relay-req-1'
    })
    const foreign = await phoneB.call('host.wake.status', { wakeId: wakeIdOf(sent) })
    expect(foreign).toMatchObject({ ok: false, error: { code: 'wake_unknown' } })
    await settle(() => frames.length > 1)
    expect(frames).toHaveLength(1)
  })

  it('refuses host.wake.admin.* to a phone over the relay with forbidden', async () => {
    const { host, frames } = await openRelayBroker()
    const phone = await host.openRelayPhone('phone-a')
    await expect(phone.ready).resolves.toBe(true)

    const admin = await phone.call('host.wake.admin.targetList', {})
    expect(admin).toMatchObject({ ok: false, error: { code: 'forbidden' } })
    expect(JSON.stringify(admin)).not.toMatch(MAC_SHAPE)
    await settle(() => frames.length > 0)
    expect(frames).toHaveLength(0)
  })

  it("never readies a relay leg bound to phone-b that presents phone-a's token, and wakes nothing", async () => {
    const { host, frames } = await openRelayBroker()
    const phoneB = deviceNamed(host, 'phone-b')

    const crossed = await host.openRelayPhone('phone-a', { relayDeviceId: phoneB.deviceId })
    await expect(crossed.ready).resolves.toBe(false)
    // Why the station control: the server judged the token and refused it, not a slow or broken splice.
    await expect(crossed.handshake).resolves.toMatchObject({
      endedIn: 'e2ee-authenticated',
      cause: 'e2ee_error'
    })
    expect(host.cellUpgradePaths).toContain(`/v1/host/data/${crossed.connId}`)
    await settle(() => frames.length > 0)
    expect(frames).toHaveLength(0)
  })

  it('readies relay legs whose binding names the presenting device (positive control)', async () => {
    const { host } = await openRelayBroker()
    const phoneA = await host.openRelayPhone('phone-a', {
      relayDeviceId: deviceNamed(host, 'phone-a').deviceId
    })
    const phoneB = await host.openRelayPhone('phone-b')
    await expect(phoneA.handshake).resolves.toMatchObject({ ready: true, cause: 'authenticated' })
    await expect(phoneB.handshake).resolves.toMatchObject({ ready: true, cause: 'authenticated' })
  })

  it('refuses a revoke inside the dispatch window at the effect, then refuses the next relay frame', async () => {
    const { host, frames } = await openRelayBroker()
    const phoneA = deviceNamed(host, 'phone-a')
    const phone = await host.openRelayPhone('phone-a')
    await expect(phone.ready).resolves.toBe(true)
    const sent = await phone.call('host.wake.request', {
      targetId: host.targetId,
      requestId: 'relay-req-1'
    })
    expect(sent).toMatchObject({ ok: true })
    await settle(() => frames.length >= 1)
    expect(frames).toHaveLength(1)

    // Why: correctness must not depend on the live-connection kill landing.
    vi.spyOn(host.server['mobileSocketWiring']!, 'terminateDeviceConnections').mockReturnValue(0)
    const dispatcher = host.server['dispatcher']
    const dispatch = dispatcher.dispatchStreaming.bind(dispatcher)
    let revoked: boolean | null = null
    // Why: revoke after dispatch-time auth passed, so only the broker's effect-time judgement remains.
    vi.spyOn(dispatcher, 'dispatchStreaming').mockImplementation(
      async (...args: Parameters<typeof dispatch>) => {
        const params = args[0].params as { requestId?: string } | undefined
        if (params?.requestId === 'relay-req-revoke') {
          revoked = await host.server.revokeMobileDevice(phoneA.deviceId)
        }
        return dispatch(...args)
      }
    )

    const inWindow = await phone.call('host.wake.request', {
      targetId: host.targetId,
      requestId: 'relay-req-revoke'
    })
    expect(revoked).toBe(true)
    expect(inWindow).toMatchObject({ ok: false, error: { code: 'wake_device_revoked' } })
    const inWindowError = inWindow.error as { data?: unknown }
    expect(JSON.stringify(inWindowError.data ?? null)).not.toContain('device_revoked')

    const after = await phone.call('host.wake.request', {
      targetId: host.targetId,
      requestId: 'relay-req-after'
    })
    expect(after).toMatchObject({
      ok: false,
      error: { code: 'unauthorized', data: { reason: 'device_revoked' } }
    })

    await settle(() => frames.length > 1)
    expect(frames).toHaveLength(1)
    expect(wakeBrokerHost.current()?.store.hasGrant(phoneA.deviceId, host.targetId)).toBe(false)
    const reloaded = loadWakeBrokerStore(host.userDataPath)
    expect(reloaded.ok && reloaded.store.grants()).toEqual([])
  })
})
