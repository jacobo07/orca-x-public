import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import {
  SERVE_AUTOSTART_ROOT_TASK_PATH,
  SERVE_AUTOSTART_STATUS_SCRIPT,
  SERVE_AUTOSTART_TASK_NAME_ENV,
  SERVE_AUTOSTART_TASK_PATH_ENV,
  getServeAutostartTaskName,
  parseServeAutostartStatusOutput,
  type ServeAutostartStatus,
  type ServeAutostartTaskState
} from '../../shared/serve-autostart-status'
import { resolveServeLaunchTarget } from './launch'
import { assertLocalInvocation } from './local-invocation'
import {
  SERVE_AUTOSTART_SERVE_ARGS,
  buildServeAutostartTaskXml,
  joinWindowsCommandLineArgs
} from './serve-autostart-task-xml'
import { RuntimeClientError } from './types'

export {
  SERVE_AUTOSTART_STATUS_SCRIPT,
  SERVE_AUTOSTART_TASK_NAME_ENV,
  SERVE_AUTOSTART_TASK_PATH_ENV,
  getServeAutostartTaskName
}
export type { ServeAutostartStatus, ServeAutostartTaskState }

export const SERVE_AUTOSTART_LINUX_DOC = 'docs/reference/headless-linux-server.md'
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

export type ServeAutostartStatusOptions = {
  taskName?: string
  // Why: only the live positive control reads a task outside the root folder.
  taskPath?: string
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
        [SERVE_AUTOSTART_TASK_PATH_ENV]: options.taskPath ?? SERVE_AUTOSTART_ROOT_TASK_PATH
      }
    }
  )
  const parsed = parseServeAutostartStatusOutput(taskName, result)
  if (!parsed.ok) {
    throw unreadable(taskName, parsed.detail)
  }
  return parsed.status
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
  trigger?: 'logon' | 'none'
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
    endBoundary: options.endBoundary,
    trigger: options.trigger
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
