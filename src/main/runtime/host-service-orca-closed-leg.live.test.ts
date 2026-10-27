import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { basename, join, resolve, sep } from 'node:path'
import { cpus, tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { MOBILE_RELAY_STATUSES } from '../../shared/mobile-relay-status'
import {
  connectMobileProtocolClient,
  type MobileProtocolClient
} from './mobile-protocol-test-client'
import { call, ok, refused, registeredRepoPath, sendAndProve } from './mobile-live-leg-steps'

// Plane: a disposable windowless serve host on this Windows machine, driven by a SCRIPTED CLIENT
// (the phone protocol, not a phone). Never the Owner's profile, window or device registry.

const ELECTRON = process.env.ORCA_LIVE_HS_ELECTRON ?? ''
const APP_ROOT = process.env.ORCA_LIVE_HS_APP_ROOT ?? ''
const SCRATCH = process.env.ORCA_LIVE_HS_SCRATCH ?? ''
const EVIDENCE = process.env.ORCA_LIVE_HS_EVIDENCE ?? ''
const OWNER_DEVICES =
  process.env.ORCA_LIVE_HS_OWNER_DEVICES ??
  join(process.env.APPDATA ?? '', 'orca', 'orca-devices.json')
const READY = Boolean(ELECTRON && APP_ROOT && SCRATCH && EVIDENCE) && process.platform === 'win32'
const LABEL = 'SCRIPTED CLIENT'
const IDLE_SETTLE_MS = 60_000
const CPU_WINDOW_MS = 30_000
// Cited for leg 1b: with no cloud-linked profile the relay context read returns before its only network call.
const LEG1B_NO_NETWORK_CITATION =
  'src/main/runtime/relay/relay-auth-context.ts:10-13 (no active.profile.cloud -> return null before readFreshOrcaCloudSession); src/main/runtime/relay/relay-auth-coordinator.ts:134-141 (null context -> no openBroker / RelaySessionBroker.connect)'
const PRODUCTION_CLOUD = {
  ORCA_CLOUD_API_URL: 'https://login.onorca.dev',
  ORCA_CLOUD_CLIENT_ID: 'orca-desktop'
}

type Proc = {
  ProcessId: number
  ParentProcessId: number
  CommandLine: string | null
  WorkingSetSize: number
  PrivatePageCount: number
  KernelModeTime: number
  UserModeTime: number
}

type Readiness = {
  type: string
  runtimeId: string
  appVersion: string
  relay: { state: string; reason?: string; status?: string | null }
  pairing: { available: boolean; url?: string }
}

function snapshot(): Proc[] {
  const out = execFileSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      'Get-CimInstance Win32_Process | Select ProcessId,ParentProcessId,CommandLine,WorkingSetSize,PrivatePageCount,KernelModeTime,UserModeTime | ConvertTo-Json -Compress'
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

const lower = (s: string | null) => (s ?? '').toLowerCase()

/** Serve main processes of this app root: `--serve` as its own argument, never a `--type=` child. */
function serveMains(procs: Proc[]): Proc[] {
  return procs.filter((p) => {
    const cmd = lower(p.CommandLine)
    return cmd.includes(lower(APP_ROOT)) && /\s--serve(\s|$)/.test(cmd) && !cmd.includes('--type=')
  })
}

function scratchFamily(procs: Proc[]): Proc[] {
  return procs.filter((p) => lower(p.CommandLine).includes(lower(SCRATCH)))
}

function serveArgs(extra: string[] = []): string[] {
  return [
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
    ...extra
  ]
}

function launch(env: NodeJS.ProcessEnv, extra: string[] = []): ChildProcess {
  return spawn(ELECTRON, serveArgs(extra), {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
}

function waitReady(child: ChildProcess, log: string[]): Promise<Readiness> {
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
          resolveReady(JSON.parse(line) as Readiness)
        }
      }
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`serve exited ${code} before readiness`))
    })
  })
}

function waitExit(child: ChildProcess, ms: number): Promise<number | null | 'timeout'> {
  return new Promise((resolveExit) => {
    const timer = setTimeout(() => resolveExit('timeout'), ms)
    child.once('exit', (code) => {
      clearTimeout(timer)
      resolveExit(code)
    })
  })
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
    const alive = snapshot().filter((p) => pids.has(p.ProcessId))
    if (alive.length === 0) {
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

function runtimePipeCall(
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
        `${JSON.stringify({ id: `p17-${randomUUID()}`, authToken: meta.authToken, method, params })}\n`
      )
    )
  })
}

async function registerRepo(phone: MobileProtocolClient, userData: string, repo: string) {
  const direct = await call(phone, 'repo.add', { path: repo })
  if (!refused(direct)) {
    return 'mobile repo.add'
  }
  const viaPipe = await runtimePipeCall(userData, 'repo.add', { path: repo })
  if (viaPipe.ok !== true) {
    throw new Error(`repo.add over the runtime pipe failed: ${JSON.stringify(viaPipe.error)}`)
  }
  return 'runtime pipe repo.add (mobile repo.add refused)'
}

function idleSample(root: number, first: Proc[], second: Proc[]) {
  const a = tree(root, first)
  const b = tree(root, second)
  const ticks = (ps: Proc[]) => ps.reduce((n, p) => n + p.KernelModeTime + p.UserModeTime, 0)
  const shared = new Set(a.map((p) => p.ProcessId))
  const deltaTicks = ticks(b.filter((p) => shared.has(p.ProcessId))) - ticks(a)
  const oneCore = (deltaTicks / (CPU_WINDOW_MS * 10_000)) * 100
  return {
    workingSetBytes: b.reduce((n, p) => n + p.WorkingSetSize, 0),
    privateBytes: b.reduce((n, p) => n + p.PrivatePageCount, 0),
    cpuPercentOneCore: Number(oneCore.toFixed(3)),
    cpuPercentAllCores: Number((oneCore / cpus().length).toFixed(3)),
    logicalCores: cpus().length,
    cpuWindowMs: CPU_WINDOW_MS,
    processCount: b.length,
    processesSampled: b.map((p) => ({
      pid: p.ProcessId,
      ws: p.WorkingSetSize,
      cmd: (p.CommandLine ?? '').slice(0, 160)
    }))
  }
}

describe.skipIf(!READY)('live Host Service leg: windowless serve, SCRIPTED CLIENT', () => {
  it('serves a paired client fresh output, starts idempotently and reports its idle cost', async () => {
    const scratch = resolve(SCRATCH)
    expect(scratch.startsWith(resolve(tmpdir()) + sep), 'scratch inside os.tmpdir()').toBe(true)
    expect(basename(scratch)).toContain('orca-hs-p17')
    const userData = join(scratch, 'userData')
    const home = join(scratch, 'home')
    const repo = join(scratch, 'repo')
    mkdirSync(home, { recursive: true })
    mkdirSync(userData, { recursive: true })
    mkdirSync(repo, { recursive: true })
    execFileSync('git', ['init', '-q', repo], { windowsHide: true })
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ORCA_E2E_USER_DATA_DIR: userData,
      ORCA_E2E_HOME_DIR: home,
      USERPROFILE: home,
      HOME: home,
      ORCA_CLOUD_API_URL: '',
      ORCA_CLOUD_CLIENT_ID: ''
    }
    const evidence: Record<string, unknown> = {
      label: LABEL,
      plane:
        'disposable windowless serve host on JACOBO-PC (win32), scratch profile, scripted phone-protocol client',
      startedAt: new Date().toISOString(),
      electron: ELECTRON,
      appRoot: APP_ROOT
    }
    const ownerHashBefore = hashOwnerDevices()
    evidence.ownerDevicesPath = OWNER_DEVICES
    evidence.ownerDevicesHashBefore =
      ownerHashBefore ?? 'ABSENT (file missing; isolation not proven by hash)'
    const baseline = snapshot()
    evidence.baselineServeMainCount = serveMains(baseline).length
    evidence.baselineScratchFamilyCount = scratchFamily(baseline).length
    const spawnedPids = new Set<number>()
    const roots: ChildProcess[] = []
    const log: string[] = []
    let phone: MobileProtocolClient | null = null
    try {
      // 1a: windowless serve host, readiness, idle cost.
      const t0 = performance.now()
      const host = launch(env)
      roots.push(host)
      const ready = await waitReady(host, log)
      evidence.startupMs = Math.round(performance.now() - t0)
      evidence.readiness1a = {
        appVersion: ready.appVersion,
        relay: ready.relay,
        runtimeId: ready.runtimeId,
        pairingAvailable: ready.pairing.available
      }
      expect(ready.appVersion, 'appVersion').toMatch(/\S/)
      expect(ready.relay).toEqual({ state: 'unavailable', reason: 'cloud_auth_not_configured' })
      expect(ready.pairing.available, 'mobile pairing offered').toBe(true)

      await new Promise((r) => setTimeout(r, IDLE_SETTLE_MS))
      const first = snapshot()
      await new Promise((r) => setTimeout(r, CPU_WINDOW_MS))
      const second = snapshot()
      const idle = idleSample(host.pid!, first, second)
      tree(host.pid!, second).forEach((p) => spawnedPids.add(p.ProcessId))
      Object.assign(evidence, { idleSettleMs: IDLE_SETTLE_MS, ...idle })

      // Pair and prove control with fresh output.
      phone = await connectMobileProtocolClient(ready.pairing.url!)
      evidence.repoRegistration = await registerRepo(phone, userData, repo)
      const repoPath = await registeredRepoPath(phone, repo)
      const handle = ok<{ terminal: { handle: string } }>(
        await call(phone, 'terminal.create', { worktree: `path:${repoPath}` }),
        'terminal.create'
      ).terminal.handle
      const marker = `ORCA-HS17-${randomUUID().slice(0, 8)}`
      const proof1 = await sendAndProve(phone, handle, marker)
      evidence.fresh1 = { verdict: 'FRESH', marker, nonce: proof1.nonce, host: proof1.host }
      expect(proof1.host).toMatch(/^HOST \S+ win32$/)
      const status = ok<{ runtimeId: string }>(await call(phone, 'status.get', {}), 'status.get')
      expect(status.runtimeId, 'client runtimeId equals readiness').toBe(ready.runtimeId)

      // Idempotent start: plain duplicate exits 3, autostart duplicate exits 0.
      const dup = launch(env)
      evidence.duplicateExitCode = await waitExit(dup, 60_000)
      if (evidence.duplicateExitCode === 'timeout' && dup.pid) {
        killTree(dup.pid)
      }
      const dupAuto = launch(env, ['--serve-autostart'])
      evidence.autostartDuplicateExitCode = await waitExit(dupAuto, 60_000)
      if (evidence.autostartDuplicateExitCode === 'timeout' && dupAuto.pid) {
        killTree(dupAuto.pid)
      }
      expect(evidence.duplicateExitCode).toBe(3)
      expect(evidence.autostartDuplicateExitCode).toBe(0)

      const statusAfter = ok<{ runtimeId: string }>(
        await call(phone, 'status.get', {}),
        'status.get'
      )
      const mains = serveMains(snapshot()).length - (evidence.baselineServeMainCount as number)
      const proof2 = await sendAndProve(phone, handle, marker)
      evidence.serveMainProcessCount = mains
      evidence.runtimeIdUnchanged = statusAfter.runtimeId === ready.runtimeId
      evidence.fresh2 = { verdict: 'FRESH', nonce: proof2.nonce, host: proof2.host }
      expect(evidence.runtimeIdUnchanged).toBe(true)
      expect(mains).toBe(1)
      await call(phone, 'terminal.close', { terminal: handle })
      await phone.close()
      phone = null

      // 1b: relaunch with production cloud config; no stored identity, so no outbound auth (cited).
      tree(host.pid!, snapshot()).forEach((p) => spawnedPids.add(p.ProcessId))
      killTree(host.pid!)
      expect(await reaped(spawnedPids), '1a tree reaped').toBe(true)
      evidence.leg1bNoNetworkCitation = LEG1B_NO_NETWORK_CITATION
      const host1b = launch({ ...env, ...PRODUCTION_CLOUD })
      roots.push(host1b)
      const ready1b = await waitReady(host1b, log)
      tree(host1b.pid!, snapshot()).forEach((p) => spawnedPids.add(p.ProcessId))
      evidence.readiness1b = { relay: ready1b.relay, appVersion: ready1b.appVersion }
      expect(ready1b.relay.state).toBe('started')
      const reported = ready1b.relay.status ?? null
      expect(
        reported === null || (MOBILE_RELAY_STATUSES as readonly string[]).includes(reported)
      ).toBe(true)
    } finally {
      await phone?.close()
      for (const root of roots) {
        if (root.pid) {
          tree(root.pid, snapshot()).forEach((p) => spawnedPids.add(p.ProcessId))
          killTree(root.pid)
        }
      }
      evidence.spawnedPidsReaped = await reaped(spawnedPids)
      const after = snapshot()
      evidence.serveMainCountAfterTeardown = serveMains(after).length
      evidence.scratchFamilyCountAfterTeardown = scratchFamily(after).length
      writeFileSync(join(tmpdir(), `${basename(scratch)}-host.log`), log.join('\n'))
      rmSync(scratch, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 })
      evidence.scratchAbsentAfterTeardown = !existsSync(scratch)
      const ownerHashAfter = hashOwnerDevices()
      evidence.ownerDevicesHashAfter = ownerHashAfter ?? 'ABSENT'
      evidence.ownerDevicesUnchanged =
        ownerHashBefore === null ? 'UNKNOWN (file absent)' : ownerHashBefore === ownerHashAfter
      evidence.finishedAt = new Date().toISOString()
      writeFileSync(EVIDENCE, `${JSON.stringify(evidence, null, 2)}\n`)
      console.log(`[${LABEL}] evidence ${JSON.stringify(evidence)}`)
    }
    expect(evidence.spawnedPidsReaped).toBe(true)
    expect(evidence.serveMainCountAfterTeardown).toBe(evidence.baselineServeMainCount)
    expect(evidence.scratchFamilyCountAfterTeardown).toBe(evidence.baselineScratchFamilyCount)
    expect(evidence.scratchAbsentAfterTeardown).toBe(true)
    if (ownerHashBefore !== null) {
      expect(evidence.ownerDevicesUnchanged).toBe(true)
    }
  }, 480_000)
})
