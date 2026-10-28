import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import nacl from 'tweetnacl'
import WebSocket, { type RawData } from 'ws'
import { OrcaRuntimeService } from './orca-runtime'
import { parseJsonObject, startLoopbackRelayCell } from './relay/loopback-relay-cell'
import { deriveRelayHostId } from './relay/relay-http-client'
import { SimulatedMobileE2EEV2Peer } from './relay/simulated-mobile-e2ee-v2-peer'
import { CloudRelayTransport } from './rpc/relay-transport'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { makeStore } from './runtime-rpc-worktree-store-fixtures'
import { startWakeBroker, wakeBrokerHost } from './wake-broker-host'
import { loadWakeBrokerStore } from './wake-broker-store'

// UNIT in-process relay: loopback relay cell, real CloudRelayTransport and real RuntimeRpcServer; never M3.

const READY_TIMEOUT_MS = 2000
const REPLY_TIMEOUT_MS = 5000
const ATTACH_DEADLINE_MS = 5000
const TARGET_MAC = '02:00:5e:20:00:01'
const TARGET_LABEL = 'Relay loopback'

type PhoneHandshakeState = 'relay-hello' | 'e2ee-ready' | 'e2ee-authenticated' | 'ready'

// Why a cause, not a boolean: a refused binding must be told apart from a slow or broken splice.
export type RelayHandshake = {
  ready: boolean
  endedIn: PhoneHandshakeState
  cause: 'authenticated' | 'e2ee_error' | 'timeout' | 'closed' | 'protocol'
  e2eeError: unknown
}

export type RelayPhone = {
  connId: string
  ready: Promise<boolean>
  handshake: Promise<RelayHandshake>
  call(method: string, params: unknown): Promise<Record<string, unknown>>
  close(): void
}

export type RelayWakeHarness = {
  server: OrcaRuntimeRpcServer
  userDataPath: string
  relayHostId: string
  targetId: string
  targetMac: string
  targetLabel: string
  devices: { name: string; deviceId: string; deviceToken: string }[]
  cellUpgradePaths: string[]
  openRelayPhone(deviceName: string, options?: { relayDeviceId?: string }): Promise<RelayPhone>
  close(): Promise<void>
}

type PhonePeerArgs = {
  url: string
  credential: string
  deviceToken: string
  desktopPublicKey: Uint8Array
  relayHostId: string
}

function openPhonePeer(args: PhonePeerArgs) {
  const socket = new WebSocket(args.url, {
    perMessageDeflate: false,
    handshakeTimeout: READY_TIMEOUT_MS
  })
  const peer = new SimulatedMobileE2EEV2Peer(
    nacl.box.keyPair(),
    args.desktopPublicKey,
    args.relayHostId
  )
  const waiters = new Map<string, (reply: Record<string, unknown>) => void>()
  let state: PhoneHandshakeState = 'relay-hello'
  let resolveHandshake: (outcome: RelayHandshake) => void = () => undefined
  const handshake = new Promise<RelayHandshake>((resolve) => {
    resolveHandshake = resolve
  })
  let timer: ReturnType<typeof setTimeout> | null = null
  const settle = (cause: RelayHandshake['cause'], e2eeError: unknown = null): void => {
    if (timer) {
      clearTimeout(timer)
    }
    resolveHandshake({ ready: cause === 'authenticated', endedIn: state, cause, e2eeError })
  }

  const onHandshakeFrame = (raw: RawData): void => {
    if (state === 'relay-hello') {
      const hello = parseJsonObject(raw.toString())
      if (hello?.type !== 'relay-hello' || hello.ok !== true) {
        settle('protocol')
        return
      }
      state = 'e2ee-ready'
      socket.send(JSON.stringify(peer.hello))
      return
    }
    if (!peer.acceptReady(parseJsonObject(raw.toString()))) {
      settle('protocol')
      return
    }
    state = 'e2ee-authenticated'
    const auth = { type: 'e2ee_auth', v: 2, transcriptHashB64: peer.transcriptHashB64 }
    socket.send(peer.sealText(JSON.stringify({ ...auth, deviceToken: args.deviceToken })))
  }

  socket.once('open', () => {
    // Why from open: the 2000 ms bound is the handshake's, not the loopback connect's under load.
    timer = setTimeout(() => settle('timeout'), READY_TIMEOUT_MS)
    socket.send(
      JSON.stringify({ type: 'relay-auth', v: 1, mode: 'connect', credential: args.credential })
    )
  })
  socket.once('close', () => settle('closed'))
  socket.on('error', () => settle('closed'))
  socket.on('message', (raw, isBinary) => {
    if (state === 'relay-hello' || state === 'e2ee-ready') {
      onHandshakeFrame(raw)
      return
    }
    if (isBinary) {
      // Why open and drop: inbound frames share one counter, so a skipped frame would desync every reply.
      peer.openBinary(new Uint8Array(raw as Buffer))
      return
    }
    const message = parseJsonObject(peer.openText(raw.toString()))
    if (state === 'e2ee-authenticated') {
      if (message?.type === 'e2ee_authenticated') {
        state = 'ready'
        settle('authenticated')
      } else {
        settle(message?.type === 'e2ee_error' ? 'e2ee_error' : 'protocol', message?.error ?? null)
      }
      return
    }
    if (message && typeof message.id === 'string') {
      waiters.get(message.id)?.(message)
    }
  })

  let seq = 0
  const call = (method: string, params: unknown): Promise<Record<string, unknown>> => {
    const id = `${method}-${++seq}`
    return new Promise((resolve, reject) => {
      const deadline = setTimeout(() => {
        waiters.delete(id)
        reject(new Error(`no relay reply for ${id} within ${REPLY_TIMEOUT_MS} ms`))
      }, REPLY_TIMEOUT_MS)
      waiters.set(id, (reply) => {
        clearTimeout(deadline)
        waiters.delete(id)
        resolve(reply)
      })
      socket.send(peer.sealText(JSON.stringify({ id, method, params })))
    })
  }
  return { handshake, ready: handshake.then((outcome) => outcome.ready), socket, call }
}

type TeardownStep = () => unknown

// Why reverse and keep going: one failed step must not strand the resources acquired before it.
async function unwindTeardown(steps: TeardownStep[]): Promise<unknown[]> {
  const errors: unknown[] = []
  // Why splice: a second unwind (close after a failed close) finds nothing left to release twice.
  const pending = steps.splice(0)
  for (let index = pending.length - 1; index >= 0; index--) {
    try {
      await pending[index]()
    } catch (error) {
      errors.push(error)
    }
  }
  return errors
}

export async function startRelayWakeHarness(options: {
  port: number
  devices: { name: string; grant: boolean }[]
}): Promise<RelayWakeHarness> {
  const teardown: TeardownStep[] = []
  try {
    return await acquireRelayWakeHarness(options, teardown)
  } catch (error) {
    const errors = await unwindTeardown(teardown)
    throw errors.length > 0
      ? new AggregateError(
          [error, ...errors],
          'relay harness setup failed and teardown also failed'
        )
      : error
  }
}

async function acquireRelayWakeHarness(
  options: { port: number; devices: { name: string; grant: boolean }[] },
  teardown: TeardownStep[]
): Promise<RelayWakeHarness> {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-wake-relay-'))
  teardown.push(() => rmSync(userDataPath, { recursive: true, force: true }))
  // Why before the server: the broker singleton outlives this harness, so it is reset however setup ends.
  teardown.push(() => {
    wakeBrokerHost.disable()
    wakeBrokerHost.attachDeviceAuthority(null)
  })
  const runtime = new OrcaRuntimeService(makeStore() as never)
  const server = new OrcaRuntimeRpcServer({
    runtime,
    userDataPath,
    enableWebSocket: true,
    wsPort: 0
  })
  await server.start()
  teardown.push(() => server.stop())
  const registry = server.getDeviceRegistry()
  const keypair = server.getE2EEKeypair()
  const wiring = server.getMobileSocketWiring()
  if (!registry || !keypair || !wiring) {
    throw new Error('relay harness needs the WebSocket start path (registry, E2EE key, wiring)')
  }
  // Why addDevice: createPairingOffer coalesces every unscanned mobile offer onto one pending device.
  const devices = options.devices.map((spec) => {
    const entry = registry.addDevice(spec.name, 'mobile')
    return {
      name: spec.name,
      deviceId: entry.deviceId,
      deviceToken: entry.token,
      grant: spec.grant
    }
  })
  const seeded = loadWakeBrokerStore(userDataPath)
  if (!seeded.ok) {
    throw new Error(`wake store unavailable: ${seeded.reason}`)
  }
  const target = seeded.store.addTarget({
    mac: TARGET_MAC,
    broadcast: '127.0.0.1',
    port: options.port,
    label: TARGET_LABEL
  })
  for (const device of devices.filter((d) => d.grant)) {
    seeded.store.addGrant(device.deviceId, target.targetId)
  }
  const started = startWakeBroker(userDataPath)
  if (started.state !== 'enabled' || started.targetCount !== 1) {
    throw new Error(`wake broker did not start with one target: ${JSON.stringify(started)}`)
  }

  const relayHostId = deriveRelayHostId(keypair.publicKey)
  const cell = await startLoopbackRelayCell(relayHostId)
  teardown.push(() => cell.close())
  const transport = new CloudRelayTransport({ cellUrl: cell.origin, relayHostId, generation: 1 })
  wiring.attachTransport(transport, (socket) => transport.metadataFor(socket))
  // Why before start: a start that rejects partway may still hold a socket to the cell.
  teardown.push(() => transport.stop())
  await transport.start()

  const phoneSockets: WebSocket[] = []
  teardown.push(() => {
    for (const socket of phoneSockets) {
      socket.terminate()
    }
  })
  let connSeq = 0
  return {
    server,
    userDataPath,
    relayHostId,
    targetId: target.targetId,
    targetMac: TARGET_MAC,
    targetLabel: TARGET_LABEL,
    devices: devices.map(({ name, deviceId, deviceToken }) => ({ name, deviceId, deviceToken })),
    cellUpgradePaths: cell.upgradePaths,
    async openRelayPhone(deviceName, phoneOptions = {}) {
      const device = devices.find((d) => d.name === deviceName)
      if (!device) {
        throw new Error(`relay harness has no device named ${deviceName}`)
      }
      const connId = `relay-conn-${++connSeq}`
      const { connTicket, credential } = cell.expectLeg(connId)
      await transport.openConnection({
        connId,
        connTicket,
        kind: 'invite',
        relayDeviceId: phoneOptions.relayDeviceId ?? device.deviceId,
        attachDeadlineMs: ATTACH_DEADLINE_MS
      })
      const phone = openPhonePeer({
        url: `${cell.origin.replace('http:', 'ws:')}/v1/connect/${relayHostId}`,
        credential,
        deviceToken: device.deviceToken,
        desktopPublicKey: keypair.publicKey,
        relayHostId
      })
      phoneSockets.push(phone.socket)
      return {
        connId,
        ready: phone.ready,
        handshake: phone.handshake,
        call: phone.call,
        close: () => phone.socket.close()
      }
    },
    async close() {
      const errors = await unwindTeardown(teardown)
      if (errors.length > 0) {
        throw new AggregateError(errors, 'relay harness close failed in one or more steps')
      }
    }
  }
}
