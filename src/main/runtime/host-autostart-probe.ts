import { execFile } from 'node:child_process'
import { userInfo } from 'node:os'
import type { HostCapability } from '../../shared/host-availability'
import { getWindowsSystemToolPath } from '../../shared/windows-system-tool-path'
import {
  SERVE_AUTOSTART_ROOT_TASK_PATH,
  SERVE_AUTOSTART_STATUS_SCRIPT,
  SERVE_AUTOSTART_TASK_NAME_ENV,
  SERVE_AUTOSTART_TASK_PATH_ENV,
  getServeAutostartTaskName,
  parseServeAutostartStatusOutput,
  type ServeAutostartStatus
} from '../../shared/serve-autostart-status'

export const AUTOSTART_STATUS_MAX_AGE_MS = 300_000
const EXEC_TIMEOUT_MS = 30_000

export type HostAutostartExecResult = { code: number; stdout: string; stderr: string }

export type HostAutostartProbeDeps = {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  now: () => number
  exec: (
    file: string,
    args: readonly string[],
    options: { env: NodeJS.ProcessEnv }
  ) => Promise<HostAutostartExecResult>
  taskName?: string
  // Why: only the live positive control reads a task outside the root folder.
  taskPath?: string
}

export type HostAutostartProbe = {
  read(): HostCapability
  // Why: lets callers that need the fresh answer (tests, the live leg) wait without polling.
  settled(): Promise<void>
}

function runAutostartStatusCommand(
  file: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv }
): Promise<HostAutostartExecResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      [...args],
      { env: options.env, timeout: EXEC_TIMEOUT_MS, windowsHide: true, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ code: 0, stdout, stderr })
          return
        }
        // Why: a spawn failure or timeout has no numeric exit code; -1 keeps it a failure, never a success.
        const code = typeof error.code === 'number' ? error.code : -1
        resolve({ code, stdout, stderr: stderr || error.message })
      }
    )
  })
}

export function defaultHostAutostartProbeDeps(): HostAutostartProbeDeps {
  return {
    platform: process.platform,
    env: process.env,
    now: Date.now,
    exec: runAutostartStatusCommand,
    taskName: getServeAutostartTaskName(userInfo().username)
  }
}

const UNREADABLE: HostCapability = {
  value: 'unknown',
  reason: 'autostart_status_unreadable',
  evidence: null
}

function capabilityFromStatus(status: ServeAutostartStatus, observedAt: number): HostCapability {
  const evidence = { kind: 'os-probe', observedAt } as const
  if (!status.installed) {
    return { value: 'not-configured', reason: 'logon_task_absent', evidence }
  }
  switch (status.state) {
    case 'ready':
    case 'running':
    case 'queued':
      return { value: 'supported', reason: 'logon_task_installed', evidence }
    case 'disabled':
      return { value: 'not-configured', reason: 'logon_task_disabled', evidence }
    case 'unknown':
      return { value: 'unknown', reason: 'logon_task_state_unknown', evidence: null }
  }
}

function offWindowsCapability(platform: NodeJS.Platform, nowMs: number): HostCapability {
  // Why: phase 17 ships the logon task for Windows only; Linux uses a systemd unit Orca cannot read here.
  return platform === 'darwin'
    ? {
        value: 'not-supported',
        reason: 'autostart_not_shipped_for_platform',
        evidence: { kind: 'host-announced', observedAt: nowMs }
      }
    : { value: 'unknown', reason: 'autostart_not_observable_on_platform', evidence: null }
}

// Why no timer: reads are request-driven and bounded to one PowerShell per max age per process (R4).
export function createHostAutostartProbe(deps: HostAutostartProbeDeps): HostAutostartProbe {
  const taskName = deps.taskName ?? getServeAutostartTaskName(userInfo().username)
  let cached: HostCapability = {
    value: 'unknown',
    reason: 'autostart_status_pending',
    evidence: null
  }
  let completedAt: number | null = null
  let inFlight: Promise<void> | null = null

  const refresh = (): Promise<void> =>
    deps
      .exec(
        // Why absolute: a bare name resolves from the cwd before PATH on Windows.
        getWindowsSystemToolPath('WindowsPowerShell\\v1.0\\powershell.exe', deps.env),
        ['-NoProfile', '-NonInteractive', '-Command', SERVE_AUTOSTART_STATUS_SCRIPT],
        {
          env: {
            ...deps.env,
            [SERVE_AUTOSTART_TASK_NAME_ENV]: taskName,
            [SERVE_AUTOSTART_TASK_PATH_ENV]: deps.taskPath ?? SERVE_AUTOSTART_ROOT_TASK_PATH
          }
        }
      )
      .then(
        (result) => {
          const parsed = parseServeAutostartStatusOutput(taskName, result)
          cached = parsed.ok ? capabilityFromStatus(parsed.status, deps.now()) : UNREADABLE
        },
        (error: unknown) => {
          console.warn('[host-availability] autostart status read failed:', String(error))
          cached = UNREADABLE
        }
      )
      .finally(() => {
        completedAt = deps.now()
        inFlight = null
      })

  return {
    read: () => {
      if (deps.platform !== 'win32') {
        return offWindowsCapability(deps.platform, deps.now())
      }
      const stale = completedAt === null || deps.now() - completedAt >= AUTOSTART_STATUS_MAX_AGE_MS
      if (stale && inFlight === null) {
        inFlight = refresh()
      }
      return cached
    },
    settled: () => inFlight ?? Promise.resolve()
  }
}
