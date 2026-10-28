import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createSocket, type Socket } from 'node:dgram'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { basename, join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { composeWakeProgress, type HostWakeRequestResult } from '../../shared/host-wake'
import { encodePairingOffer, parsePairingCode } from '../../shared/pairing'
import {
  connectMobileProtocolClient,
  type MobileProtocolClient
} from './mobile-protocol-test-client'
import { call, ok, NO_REPLY, type LiveReply } from './mobile-live-leg-steps'

// Plane: a disposable windowless serve host on this Windows machine running as a LAN Wake Broker,
// driven by a SCRIPTED CLIENT (the phone protocol, not a phone). The target's broadcast is a loopback
// UDP listener and the MAC is locally administered and fictitious, so no frame leaves 127.0.0.1.

const LEG = process.env.ORCA_LIVE_WAKE_LEG === '1'
const ELECTRON = process.env.ORCA_LIVE_WAKE_ELECTRON ?? ''
const APP_ROOT = process.env.ORCA_LIVE_WAKE_APP_ROOT ?? ''
const SCRATCH = process.env.ORCA_LIVE_WAKE_SCRATCH ?? ''
const EVIDENCE = process.env.ORCA_LIVE_WAKE_EVIDENCE ?? ''
const OUT_BUILT_FROM = process.env.ORCA_LIVE_WAKE_OUT_BUILT_FROM ?? 'unrecorded'
const OWNER_DEVICES =
  process.env.ORCA_LIVE_WAKE_OWNER_DEVICES ??
  join(process.env.APPDATA ?? '', 'orca', 'orca-devices.json')
const LABEL = 'SCRIPTED CLIENT'
const CAPABILITY = 'host.wake-broker.v1'
const TARGET_MAC = '02:00:5e:19:00:01'
const UNREGISTERED_TARGET = 'wt_000000000000'
const MAC_SHAPED = /[0-9a-f]{2}([:-][0-9a-f]{2}){5}/i
const FRAME_WAIT_MS = 3000
const ADOPT_WINDOW_MS = 10_000

type Proc = { ProcessId: number; ParentProcessId: number; CommandLine: string | null }
type Readiness = { pairing: { available: boolean; url?: string; deviceId?: string } }
type Host = { child: ChildProcess; ready: Readiness; log: string[] }
type Status = { capabilities: string[]; pairedDeviceId: string }

function snapshot(): Proc[] {
  const out = execFileSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      'Get-CimInstance Win32_Process | Select ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress'
    ],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true }
  )
  return JSON.parse(out) as Proc[]
}

function tree(root: number, procs: Proc[]): Proc[] {
  const found = procs.filter((p) => p.ProcessId === root)
  for (let i = 0; i < found.length; i++) {
    found.push(
      ...procs.filter((p) => p.ParentProcessId === found[i].ProcessId && p.ProcessId !== root)
    )
  }
  return found
}

function scratchFamily(procs: Proc[]): Proc[] {
  return procs.filter((p) => (p.CommandLine ?? '').toLowerCase().includes(SCRATCH.toLowerCase()))
}

function killTree(pid: number): void {
  try {
    execFileSync('taskkill', ['/T', '/F', '/PID', String(pid)], {
      stdio: 'ignore',
      windowsHide: true
    })
  } catch (error) {
    // Why: taskkill exits non-zero when the tree already exited; the reap is proven by the pid check after.
    console.log(`[${LABEL}] taskkill ${pid}: ${(error as Error).message.split('\n')[0]}`)
  }
}

async function reaped(pids: Set<number>): Promise<boolean> {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (snapshot().every((p) => !pids.has(p.ProcessId))) {
      return true
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

function hashOwnerDevices(): string | null {
  return existsSync(OWNER_DEVICES)
    ? createHash('sha256').update(readFileSync(OWNER_DEVICES)).digest('hex')
    : null
}

function serveEnv(dir: string): NodeJS.ProcessEnv {
  const home = join(dir, 'home')
  return {
    ...process.env,
    ORCA_E2E_USER_DATA_DIR: join(dir, 'userData'),
    ORCA_E2E_HOME_DIR: home,
    USERPROFILE: home,
    HOME: home,
    ORCA_CLOUD_API_URL: '',
    ORCA_CLOUD_CLIENT_ID: ''
  }
}

function launch(dir: string, wakeBroker: boolean): Promise<Host> {
  const args = [
    APP_ROOT,
    '--serve',
    '--serve-json',
    '--serve-port',
    '0',
    '--serve-bind-host',
    '127.0.0.1',
    '--serve-pairing-address',
    '127.0.0.1',
    '--serve-mobile-pairing',
    ...(wakeBroker ? ['--serve-wake-broker'] : [])
  ]
  const child = spawn(ELECTRON, args, {
    env: serveEnv(dir),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  const log: string[] = []
  return new Promise((resolveReady, reject) => {
    let buffer = ''
    const timer = setTimeout(() => reject(new Error('no orca_server_ready within 120 s')), 120_000)
    child.stderr?.on('data', (d: Buffer) => log.push(d.toString('utf8')))
    child.stdout?.on('data', (d: Buffer) => {
      buffer += d.toString('utf8')
      for (let i = buffer.indexOf('\n'); i >= 0; i = buffer.indexOf('\n')) {
        const line = buffer.slice(0, i).trim()
        buffer = buffer.slice(i + 1)
        log.push(line)
        if (line.startsWith('{') && line.includes('orca_server_ready')) {
          clearTimeout(timer)
          resolveReady({ child, ready: JSON.parse(line) as Readiness, log })
        }
      }
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`serve exited ${code} before readiness: ${log.join('').slice(-600)}`))
    })
  })
}

/** A local caller like the CLI: the runtime's named pipe with its auth token, no device stamp. */
function localRuntimeCall(
  userData: string,
  method: string,
  params: unknown
): Promise<Record<string, unknown>> {
  const meta = JSON.parse(readFileSync(join(userData, 'orca-runtime.json'), 'utf8')) as {
    authToken: string
    transports: { kind: string; endpoint: string }[]
  }
  const pipe = meta.transports.find((t) => t.kind === 'named-pipe')
  if (!pipe) {
    throw new Error('orca-runtime.json lists no named-pipe transport')
  }
  return new Promise((resolveCall, reject) => {
    const socket = createConnection(pipe.endpoint)
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error('runtime pipe timeout'))
    }, 15_000)
    let buffer = ''
    socket.on('data', (d) => {
      buffer += d.toString('utf8')
      for (let i = buffer.indexOf('\n'); i >= 0; i = buffer.indexOf('\n')) {
        const frame = JSON.parse(buffer.slice(0, i)) as Record<string, unknown>
        buffer = buffer.slice(i + 1)
        if (!('_keepalive' in frame)) {
          clearTimeout(timer)
          socket.destroy()
          resolveCall(frame)
          return
        }
      }
    })
    socket.on('error', reject)
    socket.on('connect', () =>
      socket.write(
        `${JSON.stringify({ id: `p19-${randomUUID()}`, authToken: meta.authToken, method, params })}\n`
      )
    )
  })
}

function localOk<T>(response: Record<string, unknown>, what: string): T {
  if (response.ok !== true) {
    throw new Error(`${what} failed: ${JSON.stringify(response.error)}`)
  }
  return response.result as T
}

function refusalCode(response: LiveReply | Record<string, unknown>): string {
  if (response === NO_REPLY) {
    return 'NO_REPLY'
  }
  if (response.ok !== false) {
    return 'ACCEPTED'
  }
  return String((response.error as { code?: unknown } | undefined)?.code ?? 'no_code')
}

async function bindListener(frames: Buffer[]): Promise<Socket> {
  const socket = createSocket({ type: 'udp4' })
  socket.on('message', (frame) => frames.push(Buffer.from(frame)))
  await new Promise<void>((r) => socket.bind(0, '127.0.0.1', () => r()))
  return socket
}

async function framesSettle(frames: Buffer[], atLeast: number): Promise<number> {
  const deadline = Date.now() + FRAME_WAIT_MS
  while (frames.length < atLeast && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25))
  }
  // Why the full window: a second, unwanted frame must have the chance to arrive before we count.
  await new Promise((r) => setTimeout(r, Math.max(0, deadline - Date.now())))
  return frames.length
}

function isMagicPacketFor(frame: Buffer, mac: string): boolean {
  const macBytes = Buffer.from(mac.split(':').map((octet) => Number.parseInt(octet, 16)))
  if (frame.length !== 102 || !frame.subarray(0, 6).every((b) => b === 0xff)) {
    return false
  }
  for (let block = 0; block < 16; block++) {
    const at = 6 + block * 6
    if (!frame.subarray(at, at + 6).equals(macBytes)) {
      return false
    }
  }
  return true
}

function stageNames(stages: { stage: string }[]): string[] {
  return stages.map((s) => s.stage)
}

/** The same device credential, addressed at a relaunched host's new listener. */
function sameDeviceAt(pairingUrl: string, freshOfferUrl: string): string {
  const device = parsePairingCode(pairingUrl)
  const fresh = parsePairingCode(freshOfferUrl)
  if (!device || !fresh) {
    throw new Error('pairing URL did not parse')
  }
  return encodePairingOffer({ ...device, endpoint: fresh.endpoint })
}

/** Every phone-method reply of the run, kept so the no-MAC claim covers all of them. */
function phoneLedger() {
  const replies: { method: string; reply: unknown }[] = []
  return {
    replies,
    async call(phone: MobileProtocolClient, method: string, params: unknown) {
      const reply = await call(phone, method, params)
      replies.push({ method, reply: reply === NO_REPLY ? 'NO_REPLY' : reply })
      return reply
    }
  }
}

describe.runIf(process.platform === 'win32' && LEG)(
  'live LAN Wake Broker leg: disposable serve host, SCRIPTED CLIENT',
  () => {
    it('grants, refusals, idempotency, adoption and the no-broker host, each counted at a loopback listener', async () => {
      expect(ELECTRON && APP_ROOT && SCRATCH && EVIDENCE, 'ORCA_LIVE_WAKE_* env').toBeTruthy()
      const scratch = resolve(SCRATCH)
      expect(scratch.startsWith(resolve(tmpdir()) + sep), 'scratch inside os.tmpdir()').toBe(true)
      expect(basename(scratch)).toContain('orca-wake-p19')
      const brokerDir = join(scratch, 'broker')
      const plainDir = join(scratch, 'nobroker')
      for (const dir of [brokerDir, plainDir]) {
        for (const sub of ['userData', 'home']) {
          mkdirSync(join(dir, sub), { recursive: true })
        }
      }
      const head = execFileSync('git', ['-C', APP_ROOT, 'rev-parse', 'HEAD'], {
        encoding: 'utf8',
        windowsHide: true
      }).trim()
      const evidence: Record<string, unknown> = {
        label: LABEL,
        plane:
          'disposable windowless serve host on this Windows laptop, --serve-wake-broker, scratch userData and home, loopback only; scripted phone-protocol client',
        head,
        outBuiltFrom: OUT_BUILT_FROM,
        startedAt: new Date().toISOString(),
        targetMac: `${TARGET_MAC} (locally administered, fictitious)`
      }
      const ownerHashBefore = hashOwnerDevices()
      evidence.ownerDevicesHashBefore = ownerHashBefore ?? 'ABSENT'
      evidence.baselineScratchFamilyCount = scratchFamily(snapshot()).length
      const frames: Buffer[] = []
      const listener = await bindListener(frames)
      const listenerPort = listener.address().port
      const spawnedPids = new Set<number>()
      const hosts: Host[] = []
      const phones: MobileProtocolClient[] = []
      const ledger = phoneLedger()
      const steps: Record<string, unknown>[] = []
      const acceptedWakeIds = new Set<string>()
      const connect = async (url: string) => {
        const phone = await connectMobileProtocolClient(url)
        phones.push(phone)
        return phone
      }
      const stop = async (host: Host) => {
        const pids = new Set(tree(host.child.pid!, snapshot()).map((p) => p.ProcessId))
        pids.add(host.child.pid!)
        pids.forEach((pid) => spawnedPids.add(pid))
        killTree(host.child.pid!)
        return reaped(pids)
      }
      const step = async (name: string, reply: LiveReply, expectFrames: number) => {
        const count = await framesSettle(frames, expectFrames)
        const result = reply !== NO_REPLY && reply.ok === true ? reply.result : null
        const wake = result as Partial<HostWakeRequestResult> | null
        steps.push({
          step: name,
          code: refusalCode(reply),
          listenerCountAfter: count,
          ...(wake?.wakeId
            ? { wakeId: wake.wakeId, replayed: wake.replayed, adopted: wake.adopted }
            : {}),
          ...(wake?.stages ? { stages: stageNames(wake.stages) } : {})
        })
        if (wake?.wakeId) {
          acceptedWakeIds.add(wake.wakeId)
        }
        return { count, wake }
      }
      try {
        // Tracer: broker host, device A granted, one wake.
        const host = await launch(brokerDir, true)
        hosts.push(host)
        const urlA = host.ready.pairing.url!
        const phoneA = await connect(urlA)
        const statusA = ok<Status>(await ledger.call(phoneA, 'status.get', {}), 'status.get')
        evidence.capabilitiesHaveWakeBroker = statusA.capabilities.includes(CAPABILITY)
        evidence.brokerServeLine = host.log.join('').match(/\[serve\] wake broker: [^\n]*/)?.[0]
        expect(statusA.capabilities).toContain(CAPABILITY)
        const deviceA = statusA.pairedDeviceId
        expect(deviceA, 'A reads its own pairedDeviceId').toBe(host.ready.pairing.deviceId)

        const userData = join(brokerDir, 'userData')
        const addReply = await localRuntimeCall(userData, 'host.wake.admin.targetAdd', {
          mac: TARGET_MAC,
          broadcast: '127.0.0.1',
          port: listenerPort,
          label: 'p19'
        })
        const targetId = localOk<{ target: { targetId: string } }>(addReply, 'targetAdd').target
          .targetId
        localOk(
          await localRuntimeCall(userData, 'host.wake.admin.grantAdd', {
            deviceId: deviceA,
            targetId
          }),
          'grantAdd'
        )
        evidence.admin = { transport: 'runtime named pipe (local caller)', targetId }
        // Positive control for the no-MAC sweep: the local admin reply does carry the MAC.
        evidence.macDetectorPositiveControl = MAC_SHAPED.test(JSON.stringify(addReply))

        const tracerReply = await ledger.call(phoneA, 'host.wake.request', {
          targetId,
          requestId: `p19-${randomUUID()}`
        })
        const sent = ok<HostWakeRequestResult>(tracerReply, 'host.wake.request')
        const { count } = await step('A granted wake (tracer)', tracerReply, 1)
        const status = ok<{ stages: { stage: string }[] }>(
          await ledger.call(phoneA, 'host.wake.status', { wakeId: sent.wakeId }),
          'host.wake.status'
        )
        // Why null: the fictitious target never answers status.get, so nothing may claim it woke.
        const composed = stageNames(composeWakeProgress(status.stages, null))
        evidence.tracer = {
          stages: stageNames(sent.stages),
          composed,
          wakeId: sent.wakeId,
          replayed: sent.replayed,
          adopted: sent.adopted
        }
        evidence.frameLength = frames[0]?.length ?? null
        evidence.frameHexPrefix = frames[0]?.subarray(0, 12).toString('hex') ?? null
        expect(stageNames(sent.stages)).toEqual(['requested', 'authorized', 'packet-sent'])
        expect(count).toBe(1)
        expect(frames[0]!.length).toBe(102)
        expect(isMagicPacketFor(frames[0]!, TARGET_MAC)).toBe(true)
        expect(composed).toEqual(['requested', 'authorized', 'packet-sent'])

        // Relaunch on the same profile: a paired A leaves the next offer free for a new device B.
        await phoneA.close()
        evidence.brokerHostRelaunchReaped = await stop(host)
        expect(evidence.brokerHostRelaunchReaped).toBe(true)
        const relaunched = await launch(brokerDir, true)
        hosts.push(relaunched)
        evidence.relaunchServeLine = relaunched.log
          .join('')
          .match(/\[serve\] wake broker: [^\n]*/)?.[0]
        const urlB = relaunched.ready.pairing.url!
        const phoneB = await connect(urlB)
        const deviceB = ok<Status>(
          await ledger.call(phoneB, 'status.get', {}),
          'status.get'
        ).pairedDeviceId
        expect(deviceB).not.toBe(deviceA)
        const phoneA2 = await connect(sameDeviceAt(urlA, urlB))
        expect(
          ok<Status>(await ledger.call(phoneA2, 'status.get', {}), 'status.get').pairedDeviceId
        ).toBe(deviceA)

        const bTargets = await ledger.call(phoneB, 'host.wake.targets', {})
        evidence.deviceBTargets = ok<{ targets: unknown[] }>(bTargets, 'targets B').targets
        expect(evidence.deviceBTargets).toEqual([])
        const aTargets = ok<{ targets: { targetId: string }[] }>(
          await ledger.call(phoneA2, 'host.wake.targets', {}),
          'targets A'
        ).targets
        expect(aTargets.map((t) => t.targetId)).toEqual([targetId])

        const before = frames.length
        const bWake = await step(
          'B (no grant) requests the registered target',
          await ledger.call(phoneB, 'host.wake.request', {
            targetId,
            requestId: `p19-${randomUUID()}`
          }),
          before + 1
        )
        const bUnknown = await step(
          'B requests an unregistered target id',
          await ledger.call(phoneB, 'host.wake.request', {
            targetId: UNREGISTERED_TARGET,
            requestId: `p19-${randomUUID()}`
          }),
          before + 1
        )
        expect(steps.at(-2)!.code).toBe('wake_grant_missing')
        expect(steps.at(-1)!.code).toBe('wake_grant_missing')
        expect(bWake.count).toBe(before)
        expect(bUnknown.count).toBe(before)

        const requestId = `p19-${randomUUID()}`
        const firstAt = Date.now()
        const first = await step(
          'A sends requestId R (first)',
          await ledger.call(phoneA2, 'host.wake.request', { targetId, requestId }),
          before + 1
        )
        const second = await step(
          'A sends the same requestId R again',
          await ledger.call(phoneA2, 'host.wake.request', { targetId, requestId }),
          before + 2
        )
        expect(first.wake?.replayed).toBe(false)
        expect(second.wake?.replayed).toBe(true)
        expect(second.wake?.wakeId).toBe(first.wake?.wakeId)
        expect(first.count).toBe(before + 1)
        expect(second.count).toBe(before + 1)
        const bStatus = await ledger.call(phoneB, 'host.wake.status', {
          wakeId: first.wake!.wakeId!
        })
        evidence.deviceBStatusOfAWake = refusalCode(bStatus)
        expect(evidence.deviceBStatusOfAWake).toBe('wake_unknown')

        const adoptSentAfterMs = Date.now() - firstAt
        const framesBeforeAdopt = frames.length
        let adopt = await step(
          'A sends a new requestId inside the adoption window',
          await ledger.call(phoneA2, 'host.wake.request', {
            targetId,
            requestId: `p19-${randomUUID()}`
          }),
          framesBeforeAdopt + 1
        )
        evidence.adoptionTiming = {
          msSinceFirstWakeRequested: adoptSentAfterMs,
          windowMs: ADOPT_WINDOW_MS,
          fallbackUsed: false
        }
        if (!adopt.wake?.adopted && adoptSentAfterMs >= ADOPT_WINDOW_MS) {
          // Why: the window had passed, so that step started its own wake; adopt it back to back.
          evidence.adoptionTiming = { ...(evidence.adoptionTiming as object), fallbackUsed: true }
          const startedWake = adopt.wake?.wakeId
          const framesBeforeFallback = frames.length
          adopt = await step(
            'A sends another new requestId back to back (window had passed)',
            await ledger.call(phoneA2, 'host.wake.request', {
              targetId,
              requestId: `p19-${randomUUID()}`
            }),
            framesBeforeFallback + 1
          )
          expect(adopt.wake?.wakeId).toBe(startedWake)
          expect(adopt.count).toBe(framesBeforeFallback)
        } else {
          expect(adopt.wake?.wakeId).toBe(first.wake?.wakeId)
          expect(adopt.count).toBe(framesBeforeAdopt)
        }
        expect(adopt.wake?.adopted).toBe(true)

        const leaked = ledger.replies.filter((r) => MAC_SHAPED.test(JSON.stringify(r.reply)))
        evidence.phoneRepliesChecked = ledger.replies.length
        evidence.phoneRepliesWithMacShape = leaked.map((r) => r.method)
        expect(evidence.macDetectorPositiveControl).toBe(true)
        expect(leaked).toEqual([])

        // Negative half: the same out/ without --serve-wake-broker.
        evidence.brokerHostStopReaped = await stop(relaunched)
        expect(evidence.brokerHostStopReaped).toBe(true)
        const plain = await launch(plainDir, false)
        hosts.push(plain)
        const phoneC = await connect(plain.ready.pairing.url!)
        const statusC = ok<Status>(await ledger.call(phoneC, 'status.get', {}), 'status.get')
        const beforePlain = frames.length
        const plainWake = await step(
          'paired device on a host without --serve-wake-broker requests a wake',
          await ledger.call(phoneC, 'host.wake.request', {
            targetId,
            requestId: `p19-${randomUUID()}`
          }),
          beforePlain + 1
        )
        const plainTargets = await ledger.call(phoneC, 'host.wake.targets', {})
        const plainAdmin = await localRuntimeCall(
          join(plainDir, 'userData'),
          'host.wake.admin.targetList',
          null
        )
        evidence.noBrokerHost = {
          capabilitiesHaveWakeBroker: statusC.capabilities.includes(CAPABILITY),
          positiveControlCapabilityCount: statusC.capabilities.length,
          requestCode: steps.at(-1)!.code,
          targetsCode: refusalCode(plainTargets),
          localAdminTargetListCode: refusalCode(plainAdmin),
          serveWakeLine: plain.log.join('').match(/\[serve\] wake broker: [^\n]*/)?.[0] ?? 'absent'
        }
        expect(statusC.capabilities.length).toBeGreaterThan(0)
        expect(statusC.capabilities).not.toContain(CAPABILITY)
        expect(steps.at(-1)!.code).toBe('wake_broker_disabled')
        expect(refusalCode(plainTargets)).toBe('wake_broker_disabled')
        expect(refusalCode(plainAdmin)).toBe('wake_broker_disabled')
        expect(plainWake.count).toBe(beforePlain)

        evidence.distinctAcceptedWakes = acceptedWakeIds.size
        evidence.listenerCount = frames.length
        evidence.everyFrameIsMagicPacketForTarget = frames.every((f) =>
          isMagicPacketFor(f, TARGET_MAC)
        )
        expect(frames.length).toBe(acceptedWakeIds.size)
        expect(evidence.everyFrameIsMagicPacketForTarget).toBe(true)
      } finally {
        evidence.steps = steps
        await Promise.all(phones.map((phone) => phone.close()))
        for (const h of hosts) {
          if (h.child.pid) {
            tree(h.child.pid, snapshot()).forEach((p) => spawnedPids.add(p.ProcessId))
            spawnedPids.add(h.child.pid)
            killTree(h.child.pid)
          }
        }
        await new Promise<void>((r) => listener.close(() => r()))
        evidence.listenerCountFinal = frames.length
        evidence.spawnedPidsReaped = await reaped(spawnedPids)
        evidence.scratchFamilyCountAfterTeardown = scratchFamily(snapshot()).length
        writeFileSync(
          join(tmpdir(), `${basename(scratch)}-host.log`),
          hosts.map((h) => h.log.join('\n')).join('\n---\n')
        )
        rmSync(scratch, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 })
        evidence.scratchDirsAbsentAfterTeardown = {
          broker: !existsSync(brokerDir),
          nobroker: !existsSync(plainDir),
          parent: !existsSync(scratch)
        }
        const ownerHashAfter = hashOwnerDevices()
        evidence.ownerDevicesHashAfter = ownerHashAfter ?? 'ABSENT'
        evidence.ownerDevicesUnchanged =
          ownerHashBefore === null ? 'UNKNOWN (file absent)' : ownerHashBefore === ownerHashAfter
        evidence.finishedAt = new Date().toISOString()
        writeFileSync(EVIDENCE, `${JSON.stringify(evidence, null, 2)}\n`)
      }
      expect(evidence.spawnedPidsReaped).toBe(true)
      expect(evidence.scratchFamilyCountAfterTeardown).toBe(evidence.baselineScratchFamilyCount)
      expect(evidence.scratchDirsAbsentAfterTeardown).toEqual({
        broker: true,
        nobroker: true,
        parent: true
      })
      if (ownerHashBefore !== null) {
        expect(evidence.ownerDevicesUnchanged).toBe(true)
      }
    }, 420_000)
  }
)
