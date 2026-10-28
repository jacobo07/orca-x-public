import { createSocket, type Socket } from 'node:dgram'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { decodePairingOffer } from '../../shared/pairing'
import { OrcaRuntimeService } from './orca-runtime'
import type { RpcRequest } from './rpc/core'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import {
  authenticateMobileWsSession,
  createEncryptedWsResponseReader,
  sendEncryptedWsRequest
} from './runtime-rpc-mobile-ws-test-harness'
import { makeStore } from './runtime-rpc-worktree-store-fixtures'
import { startWakeBroker, wakeBrokerHost } from './wake-broker-host'
import { loadWakeBrokerStore } from './wake-broker-store'

// UNIT in-process (real RuntimeRpcServer): the real DeviceRegistry, the real authority attach and the
// real UDP sender, against a loopback listener. Nothing is broadcast onto the LAN.

const SETTLE_MS = 1500

let userDataPath: string | null = null
let server: OrcaRuntimeRpcServer | null = null
let listener: Socket | null = null
let closeWs: (() => void) | null = null

afterEach(async () => {
  closeWs?.()
  closeWs = null
  await server?.stop()
  server = null
  await new Promise<void>((resolve) => (listener ? listener.close(() => resolve()) : resolve()))
  listener = null
  wakeBrokerHost.disable()
  wakeBrokerHost.attachDeviceAuthority(null)
  if (userDataPath) {
    rmSync(userDataPath, { recursive: true, force: true })
    userDataPath = null
  }
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

async function openBrokerHost(port: number) {
  userDataPath = mkdtempSync(join(tmpdir(), 'orca-wake-revoke-'))
  const runtime = new OrcaRuntimeService(makeStore() as never)
  server = new OrcaRuntimeRpcServer({ runtime, userDataPath, enableWebSocket: true, wsPort: 0 })
  await server.start()
  const offer = server.createPairingOffer({ address: '127.0.0.1', name: 'phone', scope: 'mobile' })
  if (!offer.available) {
    throw new Error('WebSocket pairing unavailable')
  }
  const { deviceToken } = decodePairingOffer(offer.pairingUrl)
  const seeded = loadWakeBrokerStore(userDataPath)
  if (!seeded.ok) {
    throw new Error(`wake store unavailable: ${seeded.reason}`)
  }
  const target = seeded.store.addTarget({
    mac: 'aa:bb:cc:dd:ee:01',
    broadcast: '127.0.0.1',
    port,
    label: 'Loopback'
  })
  seeded.store.addGrant(offer.deviceId, target.targetId)
  expect(startWakeBroker(userDataPath)).toEqual({ state: 'enabled', targetCount: 1 })

  const session = await authenticateMobileWsSession(offer.pairingUrl)
  closeWs = () => session.ws.close()
  const responses = createEncryptedWsResponseReader(session)
  let seq = 0
  const callOverWs = async (method: string, params: unknown) => {
    const id = `${method}-${++seq}`
    sendEncryptedWsRequest(session, { id, method, params })
    return (await responses.next(id)) as Record<string, unknown>
  }
  // Why the dispatcher directly: the in-flight window after dispatch-time auth, where only the broker judges.
  const callInFlight = async (method: string, params: unknown) => {
    const replies: string[] = []
    await server!['dispatcher'].dispatchStreaming(
      { id: `inflight-${++seq}`, method, params } as RpcRequest,
      (response: string) => replies.push(response),
      { clientId: deviceToken, pairedDeviceId: offer.deviceId, clientKind: 'mobile' }
    )
    return JSON.parse(replies[0]!) as Record<string, unknown>
  }
  return {
    server: server!,
    deviceId: offer.deviceId,
    targetId: target.targetId,
    callOverWs,
    callInFlight
  }
}

describe('wake broker on a real RuntimeRpcServer: a revoked device sends nothing', () => {
  it('positive control wakes once; after revokeMobileDevice the device is refused and no second frame leaves', async () => {
    const frames: Buffer[] = []
    const port = await bindLoopbackListener(frames)
    const host = await openBrokerHost(port)

    const sent = await host.callOverWs('host.wake.request', {
      targetId: host.targetId,
      requestId: 'req-before-revoke'
    })
    expect(sent).toMatchObject({ ok: true })
    const stages = (sent.result as { stages: { stage: string }[] }).stages.map((s) => s.stage)
    expect(stages).toEqual(['requested', 'authorized', 'packet-sent'])
    await settle(() => frames.length >= 1)
    expect(frames).toHaveLength(1)
    expect(frames[0]!.length).toBe(102)

    // Why: correctness must not depend on the live-connection kill landing.
    vi.spyOn(host.server['mobileSocketWiring']!, 'terminateDeviceConnections').mockReturnValue(0)
    await expect(host.server.revokeMobileDevice(host.deviceId)).resolves.toBe(true)

    const inFlight = await host.callInFlight('host.wake.request', {
      targetId: host.targetId,
      requestId: 'req-after-revoke-1'
    })
    expect(inFlight).toMatchObject({ ok: false, error: { code: 'wake_device_revoked' } })
    const inFlightError = inFlight.error as { data?: unknown }
    expect(JSON.stringify(inFlightError.data ?? null)).not.toContain('device_revoked')

    const overWs = await host.callOverWs('host.wake.request', {
      targetId: host.targetId,
      requestId: 'req-after-revoke-2'
    })
    expect(overWs).toMatchObject({
      ok: false,
      error: { code: 'unauthorized', data: { reason: 'device_revoked' } }
    })

    await settle(() => frames.length > 1)
    expect(frames).toHaveLength(1)
    expect(wakeBrokerHost.current()?.store.hasGrant(host.deviceId, host.targetId)).toBe(false)
    const reloaded = loadWakeBrokerStore(userDataPath!)
    expect(reloaded.ok && reloaded.store.grants()).toEqual([])
  })
})
