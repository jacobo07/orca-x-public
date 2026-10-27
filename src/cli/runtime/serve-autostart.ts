import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { resolveServeLaunchTarget } from './launch'
import {
  SERVE_AUTOSTART_SERVE_ARGS,
  buildServeAutostartTaskXml,
  joinWindowsCommandLineArgs
} from './serve-autostart-task-xml'
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

export type ServeAutostartLaunchTarget = {
  command: string
  args: readonly string[]
  workingDirectory: string | null
}

export type ServeAutostartInstallOptions = {
  taskName?: string
  // Why: overrides exist only for the 17-03 live leg (disposable task name, expiring definition).
  launchTarget?: ServeAutostartLaunchTarget
  endBoundary?: string
}

export type ServeAutostartInstallResult = {
  installed: true
  taskName: string
  command: string
  arguments: string
}

export type ServeAutostartRemoveResult =
  | { removed: true; taskName: string }
  | { removed: false; taskName: string; reason: 'not_installed' }

// Why: the SSH relay bridge runs this CLI on the host; a remote shell must not plant a persistent host logon effect.
function assertLocalInvocation(env: NodeJS.ProcessEnv): void {
  const remoteCwd = env.ORCA_CLI_CWD
  if (typeof remoteCwd === 'string' && remoteCwd.length > 0) {
    throw new RuntimeClientError(
      'remote_invocation_refused',
      'orca serve autostart install/remove must run in a shell on the Orca host itself, not through a remote SSH session.'
    )
  }
}

function defaultLaunchTarget(env: NodeJS.ProcessEnv): ServeAutostartLaunchTarget {
  const target = resolveServeLaunchTarget(env)
  return {
    command: target.executable,
    args: [...target.appArgs, ...SERVE_AUTOSTART_SERVE_ARGS],
    workingDirectory: target.workingDirectory
  }
}

function principalUserId(env: NodeJS.ProcessEnv): string {
  return env.USERDOMAIN && env.USERNAME ? `${env.USERDOMAIN}\\${env.USERNAME}` : userInfo().username
}

export async function installServeAutostart(
  options: ServeAutostartInstallOptions = {},
  deps: ServeAutostartDeps = defaultServeAutostartDeps()
): Promise<ServeAutostartInstallResult> {
  assertServeAutostartSupported(deps.platform)
  assertLocalInvocation(deps.env)
  const taskName = options.taskName ?? defaultServeAutostartTaskName()
  const target = options.launchTarget ?? defaultLaunchTarget(deps.env)
  if (/\.(?:cmd|bat)$/i.test(target.command)) {
    // Why: a batch launcher opens a console window at every logon; the task needs the app executable.
    throw new RuntimeClientError(
      'autostart_requires_app_executable',
      `Autostart needs the Orca app executable, not the batch launcher ${target.command}. Set ORCA_APP_EXECUTABLE to Orca.exe.`
    )
  }
  const xml = buildServeAutostartTaskXml({
    userId: principalUserId(deps.env),
    command: target.command,
    args: target.args,
    workingDirectory: target.workingDirectory,
    description:
      'Starts the Orca Host Service (orca serve) at logon. Managed by `orca serve autostart`.',
    endBoundary: options.endBoundary
  })
  // Why: a fresh per-call directory keeps another process from pre-placing the file schtasks reads (T-17-10).
  const dir = mkdtempSync(join(tmpdir(), 'orca-autostart-'))
  let result: ServeAutostartExecResult
  try {
    const xmlPath = join(dir, 'task.xml')
    // Why: the XML declares UTF-16, and schtasks reads it by the UTF-16LE byte-order mark.
    writeFileSync(xmlPath, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')]))
    result = await deps.exec('schtasks.exe', ['/Create', '/XML', xmlPath, '/TN', taskName, '/F'], {
      env: deps.env
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  if (result.code !== 0) {
    throw new RuntimeClientError(
      'autostart_install_failed',
      `schtasks could not register "${taskName}" (exit ${result.code}): ${result.stderr.trim()}`
    )
  }
  return {
    installed: true,
    taskName,
    command: target.command,
    arguments: joinWindowsCommandLineArgs(target.args)
  }
}

export async function removeServeAutostart(
  options: { taskName?: string } = {},
  deps: ServeAutostartDeps = defaultServeAutostartDeps()
): Promise<ServeAutostartRemoveResult> {
  assertServeAutostartSupported(deps.platform)
  assertLocalInvocation(deps.env)
  const taskName = options.taskName ?? defaultServeAutostartTaskName()
  const status = await getServeAutostartStatus({ taskName }, deps)
  if (!status.installed) {
    return { removed: false, taskName, reason: 'not_installed' }
  }
  const result = await deps.exec('schtasks.exe', ['/Delete', '/TN', taskName, '/F'], {
    env: deps.env
  })
  if (result.code !== 0) {
    throw new RuntimeClientError(
      'autostart_remove_failed',
      `schtasks could not delete "${taskName}" (exit ${result.code}): ${result.stderr.trim()}`
    )
  }
  return { removed: true, taskName }
}

function unreadable(taskName: string, detail: string): RuntimeClientError {
  return new RuntimeClientError(
    'autostart_status_unreadable',
    `Could not read the Scheduled Task "${taskName}": ${detail}`
  )
}
