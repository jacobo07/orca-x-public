import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createSocket, type Socket } from 'node:dgram'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { basename, join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { composeWakeProgress, type HostWakeRequestResult } from '../../shared/host-wake'
import {
  connectMobileProtocolClient,
  type MobileProtocolClient
} from './mobile-protocol-test-client'
import { call, ok } from './mobile-live-leg-steps'

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
const FRAME_WAIT_MS = 3000

type Proc = { ProcessId: number; ParentProcessId: number; CommandLine: string | null }
type Readiness = { pairing: { available: boolean; url?: string; deviceId?: string } }
type Host = { child: ChildProcess; ready: Readiness; log: string[] }

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

describe.runIf(process.platform === 'win32' && LEG)(
  'live LAN Wake Broker leg: disposable serve host, SCRIPTED CLIENT',
  () => {
    it('sends one exact magic packet for one granted request, ending at packet-sent', async () => {
      expect(ELECTRON && APP_ROOT && SCRATCH && EVIDENCE, 'ORCA_LIVE_WAKE_* env').toBeTruthy()
      const scratch = resolve(SCRATCH)
      expect(scratch.startsWith(resolve(tmpdir()) + sep), 'scratch inside os.tmpdir()').toBe(true)
      expect(basename(scratch)).toContain('orca-wake-p19')
      const brokerDir = join(scratch, 'broker')
      for (const sub of ['userData', 'home']) {
        mkdirSync(join(brokerDir, sub), { recursive: true })
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
      try {
        const host = await launch(brokerDir, true)
        hosts.push(host)
        const phoneA = await connectMobileProtocolClient(host.ready.pairing.url!)
        phones.push(phoneA)
        const statusA = ok<{ capabilities: string[]; pairedDeviceId: string }>(
          await call(phoneA, 'status.get', {}),
          'status.get'
        )
        evidence.capabilitiesHaveWakeBroker = statusA.capabilities.includes(CAPABILITY)
        evidence.brokerServeLine = host.log.join('').match(/\[serve\] wake broker: [^\n]*/)?.[0]
        expect(statusA.capabilities).toContain(CAPABILITY)
        const deviceA = statusA.pairedDeviceId
        expect(deviceA, 'A reads its own pairedDeviceId').toBe(host.ready.pairing.deviceId)

        const userData = join(brokerDir, 'userData')
        const added = localOk<{ target: { targetId: string; mac: string } }>(
          await localRuntimeCall(userData, 'host.wake.admin.targetAdd', {
            mac: TARGET_MAC,
            broadcast: '127.0.0.1',
            port: listenerPort,
            label: 'p19'
          }),
          'targetAdd'
        )
        const targetId = added.target.targetId
        localOk(
          await localRuntimeCall(userData, 'host.wake.admin.grantAdd', {
            deviceId: deviceA,
            targetId
          }),
          'grantAdd'
        )
        evidence.admin = { transport: 'runtime named pipe (local caller)', targetId }

        const sent = ok<HostWakeRequestResult>(
          await call(phoneA, 'host.wake.request', { targetId, requestId: `p19-${randomUUID()}` }),
          'host.wake.request'
        )
        const count = await framesSettle(frames, 1)
        const status = ok<{ stages: { stage: string }[] }>(
          await call(phoneA, 'host.wake.status', { wakeId: sent.wakeId }),
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
        evidence.listenerCount = count
        evidence.frameLength = frames[0]?.length ?? null
        evidence.frameHexPrefix = frames[0]?.subarray(0, 12).toString('hex') ?? null
        evidence.frameIsMagicPacketForTarget = frames[0]
          ? isMagicPacketFor(frames[0], TARGET_MAC)
          : false
        expect(stageNames(sent.stages)).toEqual(['requested', 'authorized', 'packet-sent'])
        expect(count).toBe(1)
        expect(frames[0]!.length).toBe(102)
        expect(isMagicPacketFor(frames[0]!, TARGET_MAC)).toBe(true)
        expect(composed).toEqual(['requested', 'authorized', 'packet-sent'])
      } finally {
        await Promise.all(phones.map((phone) => phone.close()))
        for (const h of hosts) {
          if (h.child.pid) {
            tree(h.child.pid, snapshot()).forEach((p) => spawnedPids.add(p.ProcessId))
            spawnedPids.add(h.child.pid)
            killTree(h.child.pid)
          }
        }
        await new Promise<void>((r) => listener.close(() => r()))
        evidence.spawnedPidsReaped = await reaped(spawnedPids)
        evidence.scratchFamilyCountAfterTeardown = scratchFamily(snapshot()).length
        writeFileSync(
          join(tmpdir(), `${basename(scratch)}-host.log`),
          hosts.map((h) => h.log.join('\n')).join('\n---\n')
        )
        rmSync(scratch, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 })
        evidence.scratchAbsentAfterTeardown = !existsSync(scratch)
        const ownerHashAfter = hashOwnerDevices()
        evidence.ownerDevicesHashAfter = ownerHashAfter ?? 'ABSENT'
        evidence.ownerDevicesUnchanged =
          ownerHashBefore === null ? 'UNKNOWN (file absent)' : ownerHashBefore === ownerHashAfter
        evidence.finishedAt = new Date().toISOString()
        writeFileSync(EVIDENCE, `${JSON.stringify(evidence, null, 2)}\n`)
      }
      expect(evidence.spawnedPidsReaped).toBe(true)
      expect(evidence.scratchFamilyCountAfterTeardown).toBe(evidence.baselineScratchFamilyCount)
      expect(evidence.scratchAbsentAfterTeardown).toBe(true)
      if (ownerHashBefore !== null) {
        expect(evidence.ownerDevicesUnchanged).toBe(true)
      }
    }, 300_000)
  }
)
