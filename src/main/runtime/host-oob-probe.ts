import { execFile } from 'node:child_process'
import { access, readFile } from 'node:fs/promises'
import type { HostCapability } from '../../shared/host-availability'
import { getWindowsSystemToolPath } from '../../shared/windows-system-tool-path'
import { WINDOWS_OOB_PROBE_SCRIPT, oobVerdict, parseWindowsOobProbe } from './host-oob-verdict'

export const OOB_STATUS_MAX_AGE_MS = 600_000
const EXEC_TIMEOUT_MS = 30_000

export type HostOobExecResult = { code: number; stdout: string }

export type HostOobProbeDeps = {
  platform: NodeJS.Platform
  now: () => number
  exec: (file: string, args: readonly string[]) => Promise<HostOobExecResult>
  readText: (path: string) => Promise<string | null>
  exists: (path: string) => Promise<boolean>
  windowsPowerShellPath: string
}

export type HostOobProbe = {
  read(): HostCapability
  // Why: lets tests and the live leg wait for the fresh answer without polling.
  settled(): Promise<void>
}

const UNREADABLE: HostCapability = {
  value: 'unknown',
  reason: 'oob_probe_unreadable',
  evidence: null
}

function runOobCommand(file: string, args: readonly string[]): Promise<HostOobExecResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      [...args],
      { timeout: EXEC_TIMEOUT_MS, windowsHide: true, encoding: 'utf8' },
      (error, stdout) => {
        if (!error) {
          resolve({ code: 0, stdout })
          return
        }
        // Why: a spawn failure or timeout has no numeric exit code; -1 keeps it a failure.
        resolve({ code: typeof error.code === 'number' ? error.code : -1, stdout })
      }
    )
  })
}

export function defaultHostOobProbeDeps(): HostOobProbeDeps {
  return {
    platform: process.platform,
    now: Date.now,
    exec: runOobCommand,
    readText: (filePath) =>
      readFile(filePath, 'utf8').then(
        (text) => text,
        () => null
      ),
    exists: (filePath) =>
      access(filePath).then(
        () => true,
        () => false
      ),
    windowsPowerShellPath: getWindowsSystemToolPath('WindowsPowerShell\\v1.0\\powershell.exe')
  }
}

async function readWindows(deps: HostOobProbeDeps): Promise<HostCapability> {
  const result = await deps.exec(deps.windowsPowerShellPath, [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    WINDOWS_OOB_PROBE_SCRIPT
  ])
  const parsed = result.code === 0 ? parseWindowsOobProbe(result.stdout) : null
  if (parsed === null) {
    return UNREADABLE
  }
  return oobVerdict({
    vendor: parsed.vendor,
    meiPresent: parsed.meiCount > 0,
    observedAt: deps.now()
  })
}

function readPlatform(deps: HostOobProbeDeps): Promise<HostCapability> {
  if (deps.platform === 'win32') {
    return readWindows(deps)
  }
  return Promise.resolve({ value: 'unknown', reason: 'oob_platform_pending', evidence: null })
}

// Why no timer: reads are request-driven and bounded to one OS read per max age per process (R4).
export function createHostOobProbe(deps: HostOobProbeDeps): HostOobProbe {
  let cached: HostCapability = { value: 'unknown', reason: 'oob_probe_pending', evidence: null }
  let completedAt: number | null = null
  let inFlight: Promise<void> | null = null

  const refresh = (): Promise<void> =>
    readPlatform(deps)
      .then(
        (capability) => {
          cached = capability
        },
        (error: unknown) => {
          console.warn('[host-availability] OOB read failed:', String(error))
          cached = UNREADABLE
        }
      )
      .finally(() => {
        completedAt = deps.now()
        inFlight = null
      })

  return {
    read: () => {
      const stale = completedAt === null || deps.now() - completedAt >= OOB_STATUS_MAX_AGE_MS
      if (stale && inFlight === null) {
        inFlight = refresh()
      }
      return cached
    },
    settled: () => inFlight ?? Promise.resolve()
  }
}
