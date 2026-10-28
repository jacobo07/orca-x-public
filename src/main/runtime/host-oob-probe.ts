import { execFile } from 'node:child_process'
import { access, readFile } from 'node:fs/promises'
import type { HostCapability } from '../../shared/host-availability'
import { getWindowsSystemToolPath } from '../../shared/windows-system-tool-path'
import {
  WINDOWS_OOB_PROBE_SCRIPT,
  darwinOobVerdict,
  linuxOobVerdict,
  windowsOobVerdict
} from './host-oob-verdict'

export const OOB_STATUS_MAX_AGE_MS = 600_000
const EXEC_TIMEOUT_MS = 30_000
const LINUX_CPUINFO = '/proc/cpuinfo'
// Why both: the MEI driver names its node mei0 on current kernels and mei on older ones (research A1).
const LINUX_MEI_NODES = ['/dev/mei0', '/dev/mei'] as const
// Why absolute: no spawn may depend on PATH.
const DARWIN_SYSCTL = '/usr/sbin/sysctl'

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
  return result.code === 0 ? windowsOobVerdict(result.stdout, deps.now()) : UNREADABLE
}

async function readLinux(deps: HostOobProbeDeps): Promise<HostCapability> {
  const cpuinfo = await deps.readText(LINUX_CPUINFO)
  if (cpuinfo === null) {
    return UNREADABLE
  }
  let meiPresent = false
  for (const node of LINUX_MEI_NODES) {
    if (await deps.exists(node)) {
      meiPresent = true
      break
    }
  }
  return linuxOobVerdict(cpuinfo, meiPresent, deps.now())
}

async function readDarwin(deps: HostOobProbeDeps): Promise<HostCapability> {
  const result = await deps.exec(DARWIN_SYSCTL, ['-n', 'machdep.cpu.vendor'])
  // Why unreadable on failure: Apple silicon has no such key, and absence is not a measured verdict.
  return result.code === 0 ? darwinOobVerdict(result.stdout, deps.now()) : UNREADABLE
}

function readPlatform(deps: HostOobProbeDeps): Promise<HostCapability> {
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
        reason: 'oob_not_observable_on_platform',
        evidence: null
      })
  }
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
