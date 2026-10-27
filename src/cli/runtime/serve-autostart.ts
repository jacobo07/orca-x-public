import { execFile } from 'node:child_process'
import { userInfo } from 'node:os'
import { RuntimeClientError } from './types'

export const SERVE_AUTOSTART_LINUX_DOC = 'docs/reference/headless-linux-server.md'
export const SERVE_AUTOSTART_TASK_NAME_ENV = 'ORCA_AUTOSTART_TASK_NAME'
export const SERVE_AUTOSTART_TASK_PATH_ENV = 'ORCA_AUTOSTART_TASK_PATH'
const ROOT_TASK_PATH = '\\'
const EXEC_TIMEOUT_MS = 30_000

export type ServeAutostartExecResult = { code: number; stdout: string; stderr: string }

export type ServeAutostartDeps = {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  exec: (
    file: string,
    args: readonly string[],
    options: { env: NodeJS.ProcessEnv }
  ) => Promise<ServeAutostartExecResult>
}

export type ServeAutostartTaskState = 'unknown' | 'disabled' | 'queued' | 'ready' | 'running'

export type ServeAutostartStatus =
  | { installed: false; taskName: string }
  | {
      installed: true
      taskName: string
      state: ServeAutostartTaskState
      lastTaskResult: number | null
      lastRunTime: string | null
      command: string | null
      arguments: string | null
      workingDirectory: string | null
    }

export type ServeAutostartStatusOptions = {
  taskName?: string
  // Why: only the live positive control reads a task outside the root folder.
  taskPath?: string
}

// Why: Get-ScheduledTask enum values and ISO dates are locale-free; schtasks /Query text is translated.
// Why constant: the task name reaches PowerShell only through the environment, so it can never be code.
export const SERVE_AUTOSTART_STATUS_SCRIPT = [
  '$ErrorActionPreference = "Stop"',
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  `$task = Get-ScheduledTask -TaskName $env:${SERVE_AUTOSTART_TASK_NAME_ENV} -TaskPath $env:${SERVE_AUTOSTART_TASK_PATH_ENV} -ErrorAction SilentlyContinue -ErrorVariable lookupError`,
  'if ($null -eq $task) { if ($lookupError.Count -eq 0 -or [string]$lookupError[0].CategoryInfo.Category -eq "ObjectNotFound") { exit 0 }; [Console]::Error.WriteLine($lookupError[0].ToString()); exit 3 }',
  '$info = Get-ScheduledTaskInfo -InputObject $task',
  '$action = @($task.Actions)[0]',
  // Why: Task Scheduler reports 1999-11-30 as the last run time of a task that never ran.
  '$lastRun = if ($null -ne $info.LastRunTime -and $info.LastRunTime.Year -ge 2000) { $info.LastRunTime.ToUniversalTime().ToString("o") } else { $null }',
  '[pscustomobject]@{ State = [int]$task.State; LastTaskResult = $info.LastTaskResult; LastRunTime = $lastRun; Execute = $action.Execute; Arguments = $action.Arguments; WorkingDirectory = $action.WorkingDirectory } | ConvertTo-Json -Compress'
].join('; ')

const TASK_STATES: readonly ServeAutostartTaskState[] = [
  'unknown',
  'disabled',
  'queued',
  'ready',
  'running'
]

export function getServeAutostartTaskName(username: string): string {
  // Why: task names are machine-wide; the user suffix keeps two Windows accounts apart.
  const safe = username.replace(/[^A-Za-z0-9._-]/g, '')
  return `Orca Host Service (${safe || 'user'})`
}

export function defaultServeAutostartTaskName(): string {
  return getServeAutostartTaskName(userInfo().username)
}

export function defaultServeAutostartDeps(): ServeAutostartDeps {
  return {
    platform: process.platform,
    env: process.env,
    exec: runServeAutostartCommand
  }
}

function runServeAutostartCommand(
  file: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv }
): Promise<ServeAutostartExecResult> {
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

export function assertServeAutostartSupported(platform: NodeJS.Platform): void {
  if (platform !== 'win32') {
    throw new RuntimeClientError(
      'unsupported_platform',
      `orca serve autostart registers a Windows logon task and is Windows only. On Linux, run the Host Service as a systemd user unit: see ${SERVE_AUTOSTART_LINUX_DOC}.`
    )
  }
}

export async function getServeAutostartStatus(
  options: ServeAutostartStatusOptions = {},
  deps: ServeAutostartDeps = defaultServeAutostartDeps()
): Promise<ServeAutostartStatus> {
  assertServeAutostartSupported(deps.platform)
  const taskName = options.taskName ?? defaultServeAutostartTaskName()
  const result = await deps.exec(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', SERVE_AUTOSTART_STATUS_SCRIPT],
    {
      env: {
        ...deps.env,
        [SERVE_AUTOSTART_TASK_NAME_ENV]: taskName,
        [SERVE_AUTOSTART_TASK_PATH_ENV]: options.taskPath ?? ROOT_TASK_PATH
      }
    }
  )
  if (result.code !== 0) {
    throw unreadable(taskName, `lookup exited ${result.code}: ${result.stderr.trim()}`)
  }
  const stdout = result.stdout.trim()
  if (stdout.length === 0) {
    return { installed: false, taskName }
  }
  return parseInstalledStatus(taskName, stdout)
}

function parseInstalledStatus(taskName: string, stdout: string): ServeAutostartStatus {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch (error) {
    throw unreadable(taskName, `output is not JSON (${(error as Error).message})`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw unreadable(taskName, 'output is not a task record')
  }
  const record = parsed as Record<string, unknown>
  if (typeof record.State !== 'number') {
    throw unreadable(taskName, 'task record has no numeric State')
  }
  return {
    installed: true,
    taskName,
    state: TASK_STATES[record.State] ?? 'unknown',
    lastTaskResult: typeof record.LastTaskResult === 'number' ? record.LastTaskResult : null,
    lastRunTime: optionalString(record.LastRunTime),
    command: optionalString(record.Execute),
    arguments: optionalString(record.Arguments),
    workingDirectory: optionalString(record.WorkingDirectory)
  }
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function unreadable(taskName: string, detail: string): RuntimeClientError {
  return new RuntimeClientError(
    'autostart_status_unreadable',
    `Could not read the Scheduled Task "${taskName}": ${detail}`
  )
}
