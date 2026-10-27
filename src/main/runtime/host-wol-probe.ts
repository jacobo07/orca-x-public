import { execFile } from 'node:child_process'
import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import type { HostCapability } from '../../shared/host-availability'
import {
  WINDOWS_WOL_ADAPTER_SCRIPT,
  darwinWolVerdict,
  linuxWolVerdict,
  parseWakeArmedDevices,
  parseWindowsWolAdapters,
  windowsWolVerdict,
  type LinuxWolRow
} from './host-wol-verdict'

export const WOL_STATUS_MAX_AGE_MS = 600_000
const EXEC_TIMEOUT_MS = 30_000

export type HostWolExecResult = { code: number; stdout: string; stderr: string }

export type HostWolProbeDeps = {
  platform: NodeJS.Platform
  now: () => number
  exec: (file: string, args: readonly string[]) => Promise<HostWolExecResult>
  listPhysicalInterfaces: () => Promise<string[]>
  readText: (path: string) => Promise<string | null>
}

export type HostWolProbe = {
  read(): HostCapability
  // Why: lets tests and the live leg wait for the fresh answer without polling.
  settled(): Promise<void>
}

const UNREADABLE: HostCapability = {
  value: 'unknown',
  reason: 'wol_probe_unreadable',
  evidence: null
}

function runWolCommand(file: string, args: readonly string[]): Promise<HostWolExecResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      [...args],
      { timeout: EXEC_TIMEOUT_MS, windowsHide: true, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ code: 0, stdout, stderr })
          return
        }
        // Why: a spawn failure or timeout has no numeric exit code; -1 keeps it a failure.
        const code = typeof error.code === 'number' ? error.code : -1
        resolve({ code, stdout, stderr: stderr || error.message })
      }
    )
  })
}

const SYS_CLASS_NET = '/sys/class/net'
// Why: the name is argv to ethtool, so a leading '-' would be read as an option.
const SAFE_INTERFACE_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.@-]{0,14}$/

// Why a device link: WSL, container and virtual NICs have none, so only real hardware is listed.
async function listDeviceBackedInterfaces(): Promise<string[]> {
  let names: string[]
  try {
    names = await readdir(SYS_CLASS_NET)
  } catch (error) {
    console.debug('[host-availability] network interface list unreadable:', String(error))
    return []
  }
  const backed = await Promise.all(
    names
      .filter((name) => name !== 'lo')
      .map((name) =>
        stat(path.posix.join(SYS_CLASS_NET, name, 'device')).then(
          () => name,
          () => null
        )
      )
  )
  return backed.filter((name): name is string => name !== null)
}

function readTextOrNull(filePath: string): Promise<string | null> {
  return readFile(filePath, 'utf8').then(
    (text) => text,
    () => null
  )
}

export function defaultHostWolProbeDeps(): HostWolProbeDeps {
  return {
    platform: process.platform,
    now: Date.now,
    exec: runWolCommand,
    listPhysicalInterfaces: listDeviceBackedInterfaces,
    readText: readTextOrNull
  }
}

async function readWindows(deps: HostWolProbeDeps): Promise<HostCapability> {
  const [adapterResult, armedResult] = await Promise.all([
    deps.exec('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      WINDOWS_WOL_ADAPTER_SCRIPT
    ]),
    deps.exec('powercfg.exe', ['/devicequery', 'wake_armed'])
  ])
  if (adapterResult.code !== 0 || armedResult.code !== 0) {
    return UNREADABLE
  }
  const adapters = parseWindowsWolAdapters(adapterResult.stdout)
  if (adapters === null) {
    return UNREADABLE
  }
  return windowsWolVerdict({
    adapters,
    armed: parseWakeArmedDevices(armedResult.stdout),
    observedAt: deps.now()
  })
}

async function readLinuxRow(deps: HostWolProbeDeps, name: string): Promise<LinuxWolRow> {
  const result = await deps.exec('ethtool', [name])
  const ethtool = result.code === 0 ? result.stdout : null
  // Why: ethtool may be absent or need CAP_NET_ADMIN; sysfs still says whether wake is armed.
  const needsSysfs = ethtool === null || !ethtool.includes('Supports Wake-on:')
  const sysfsWakeup = needsSysfs
    ? await deps.readText(path.posix.join(SYS_CLASS_NET, name, 'device', 'power', 'wakeup'))
    : null
  return { name, ethtool, sysfsWakeup }
}

async function readLinux(deps: HostWolProbeDeps): Promise<HostCapability> {
  const names = (await deps.listPhysicalInterfaces()).filter((name) =>
    SAFE_INTERFACE_NAME.test(name)
  )
  const rows = await Promise.all(names.map((name) => readLinuxRow(deps, name)))
  return linuxWolVerdict(rows, deps.now())
}

async function readDarwin(deps: HostWolProbeDeps): Promise<HostCapability> {
  const result = await deps.exec('pmset', ['-g'])
  return result.code === 0 ? darwinWolVerdict(result.stdout, deps.now()) : UNREADABLE
}

function readPlatform(deps: HostWolProbeDeps): Promise<HostCapability> {
  switch (deps.platform) {
    case 'win32':
      return readWindows(deps)
    case 'linux':
      return readLinux(deps)
    case 'darwin':
      return readDarwin(deps)
    default:
      return Promise.resolve({
        value: 'unknown',
        reason: 'wol_not_observable_on_platform',
        evidence: null
      })
  }
}

// Why no timer: reads are request-driven and bounded to one OS read per max age per process (R4, D-03).
export function createHostWolProbe(deps: HostWolProbeDeps): HostWolProbe {
  let cached: HostCapability = { value: 'unknown', reason: 'wol_probe_pending', evidence: null }
  let completedAt: number | null = null
  let inFlight: Promise<void> | null = null

  const refresh = (): Promise<void> =>
    readPlatform(deps)
      .then(
        (capability) => {
          cached = capability
        },
        (error: unknown) => {
          console.warn('[host-availability] WOL read failed:', String(error))
          cached = UNREADABLE
        }
      )
      .finally(() => {
        completedAt = deps.now()
        inFlight = null
      })

  return {
    read: () => {
      const stale = completedAt === null || deps.now() - completedAt >= WOL_STATUS_MAX_AGE_MS
      if (stale && inFlight === null) {
        inFlight = refresh()
      }
      return cached
    },
    settled: () => inFlight ?? Promise.resolve()
  }
}
