// Why shared: the CLI status command and the main-process probe must run one script and one parser.
export const SERVE_AUTOSTART_TASK_NAME_ENV = 'ORCA_AUTOSTART_TASK_NAME'
export const SERVE_AUTOSTART_TASK_PATH_ENV = 'ORCA_AUTOSTART_TASK_PATH'
export const SERVE_AUTOSTART_ROOT_TASK_PATH = '\\'

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

export type ServeAutostartStatusOutput = { code: number; stdout: string; stderr: string }

export type ServeAutostartStatusParse =
  | { ok: true; status: ServeAutostartStatus }
  | { ok: false; detail: string }

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

export function parseServeAutostartStatusOutput(
  taskName: string,
  output: ServeAutostartStatusOutput
): ServeAutostartStatusParse {
  if (output.code !== 0) {
    return { ok: false, detail: `lookup exited ${output.code}: ${output.stderr.trim()}` }
  }
  const stdout = output.stdout.trim()
  if (stdout.length === 0) {
    return { ok: true, status: { installed: false, taskName } }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch (error) {
    return { ok: false, detail: `output is not JSON (${(error as Error).message})` }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, detail: 'output is not a task record' }
  }
  const record = parsed as Record<string, unknown>
  if (typeof record.State !== 'number') {
    return { ok: false, detail: 'task record has no numeric State' }
  }
  return {
    ok: true,
    status: {
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
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}
