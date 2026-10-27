import { execFile } from 'node:child_process'
import type { HostCapability } from '../../shared/host-availability'
import {
  WINDOWS_WOL_ADAPTER_SCRIPT,
  parseWakeArmedDevices,
  parseWindowsWolAdapters,
  windowsWolVerdict
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

export function defaultHostWolProbeDeps(): HostWolProbeDeps {
  return {
    platform: process.platform,
    now: Date.now,
    exec: runWolCommand,
    listPhysicalInterfaces: () => Promise.resolve([]),
    readText: () => Promise.resolve(null)
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

function readPlatform(deps: HostWolProbeDeps): Promise<HostCapability> {
  if (deps.platform === 'win32') {
    return readWindows(deps)
  }
  return Promise.resolve({ value: 'unknown', reason: 'wol_platform_pending', evidence: null })
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
