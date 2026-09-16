import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const PROCESS_QUERY_TIMEOUT_MS = 5_000
const PROCESS_QUERY_MAX_BYTES = 8 * 1024 * 1024

const processQueryOptions = {
  encoding: 'utf8' as const,
  timeout: PROCESS_QUERY_TIMEOUT_MS,
  maxBuffer: PROCESS_QUERY_MAX_BYTES,
  windowsHide: true
}

export type RecordedProcessIdentity = {
  pid: number
  startedAtMs: number
}

type ProcessRow = RecordedProcessIdentity & {
  parentPid: number
}

export async function waitForCondition(
  description: string,
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 10_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    if (await predicate()) {
      return
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`Timed out waiting for ${description}`)
}

async function readWindowsProcessRows(): Promise<ProcessRow[]> {
  const command = [
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false);',
    '$rows = Get-CimInstance Win32_Process | ForEach-Object {',
    '  [PSCustomObject]@{',
    '    pid = [int]$_.ProcessId;',
    '    parentPid = [int]$_.ParentProcessId;',
    "    startedAt = if ($null -eq $_.CreationDate) { $null } else { $_.CreationDate.ToUniversalTime().ToString('O', [System.Globalization.CultureInfo]::InvariantCulture) }",
    '  }',
    '};',
    '$rows | ConvertTo-Json -Compress'
  ].join(' ')
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
    processQueryOptions
  )
  const parsed = JSON.parse(stdout || '[]') as
    | { pid?: unknown; parentPid?: unknown; startedAt?: unknown }
    | { pid?: unknown; parentPid?: unknown; startedAt?: unknown }[]
  const rows = Array.isArray(parsed) ? parsed : [parsed]
  return rows.flatMap((row) => {
    const pid = Number(row.pid)
    const parentPid = Number(row.parentPid)
    const startedAtMs = typeof row.startedAt === 'string' ? Date.parse(row.startedAt) : Number.NaN
    return Number.isInteger(pid) && Number.isInteger(parentPid) && Number.isFinite(startedAtMs)
      ? [{ pid, parentPid, startedAtMs }]
      : []
  })
}

async function readPosixProcessRows(): Promise<ProcessRow[]> {
  const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid=,lstart='], {
    ...processQueryOptions,
    // Why: start identity must not depend on a CI host's locale or timezone.
    env: { ...process.env, LANG: 'C', LC_ALL: 'C', TZ: 'UTC0' }
  })
  return stdout.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line)
    if (!match) {
      return []
    }
    const startedAtMs = Date.parse(`${match[3]} UTC`)
    return Number.isFinite(startedAtMs)
      ? [{ pid: Number(match[1]), parentPid: Number(match[2]), startedAtMs }]
      : []
  })
}

async function readProcessRows(): Promise<ProcessRow[]> {
  return process.platform === 'win32' ? readWindowsProcessRows() : readPosixProcessRows()
}

/**
 * The same row, for ONE pid, asked of the OS as a question about one pid.
 *
 * Why this exists: the whole-table enumeration above cannot finish inside its own 5s timeout on a
 * loaded Windows host — measured 5/5 killed at 5.4-6.9s with 1.3-2.0 GB free, and the same for a
 * lean projection, so it is the full CIM walk rather than memory or the shaping. Because every
 * real-daemon fixture reaches it through recordProcessIdentity, a single slow host took out the
 * whole family before any of them could assert anything. Production asks about one pid with a
 * filter (daemon-process-inspection.ts) and answers in ~1.8s.
 *
 * The date expression is byte-identical to the table query's on purpose: startedAtMs is compared
 * for EXACT equality by processIdentityIsAlive, so two paths that formatted it differently would
 * make a live process look like a recycled pid.
 */
async function readWindowsProcessRow(pid: number): Promise<ProcessRow | null> {
  const command = [
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false);',
    `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}";`,
    'if (-not $p) { Write-Output "null" } else {',
    '  [PSCustomObject]@{',
    '    pid = [int]$p.ProcessId;',
    '    parentPid = [int]$p.ParentProcessId;',
    "    startedAt = if ($null -eq $p.CreationDate) { $null } else { $p.CreationDate.ToUniversalTime().ToString('O', [System.Globalization.CultureInfo]::InvariantCulture) }",
    '  } | ConvertTo-Json -Compress',
    '}'
  ].join(' ')
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
    processQueryOptions
  )
  const parsed = JSON.parse(stdout.trim() || 'null') as {
    pid?: unknown
    parentPid?: unknown
    startedAt?: unknown
  } | null
  if (!parsed) {
    return null
  }
  const rowPid = Number(parsed.pid)
  const parentPid = Number(parsed.parentPid)
  const startedAtMs = typeof parsed.startedAt === 'string' ? Date.parse(parsed.startedAt) : Number.NaN
  return Number.isInteger(rowPid) && Number.isInteger(parentPid) && Number.isFinite(startedAtMs)
    ? { pid: rowPid, parentPid, startedAtMs }
    : null
}

async function readProcessRow(pid: number): Promise<ProcessRow | null> {
  // The pid is interpolated into a CIM filter, so only a validated integer may reach it.
  if (process.platform === 'win32' && Number.isInteger(pid) && pid > 0) {
    try {
      return await readWindowsProcessRow(pid)
    } catch {
      // Fall through to the table scan: a filtered query that failed is not evidence of absence,
      // and the slower path is still the more capable one.
    }
  }
  return (await readProcessRows()).find((candidate) => candidate.pid === pid) ?? null
}

export async function recordProcessIdentity(pid: number): Promise<RecordedProcessIdentity> {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`Cannot record invalid fixture pid ${pid}`)
  }
  const row = await readProcessRow(pid)
  if (!row) {
    throw new Error(`Could not record process-start identity for fixture pid ${pid}`)
  }
  return { pid, startedAtMs: row.startedAtMs }
}

export async function processIdentityIsAlive(identity: RecordedProcessIdentity): Promise<boolean> {
  const current = await readProcessRow(identity.pid)
  return current !== null && current.startedAtMs === identity.startedAtMs
}

/**
 * One table scan amortises across many pids, but teardown polls this in a loop over a handful of
 * them — and on a host where the scan cannot finish inside its timeout, that loop never converges
 * and cleanup fails with EPERM on a directory whose processes are in fact gone. Below the
 * crossover, ask per pid.
 */
const TARGETED_LIVENESS_MAX_PIDS = 4

export async function processIdentityLiveness(
  identities: readonly RecordedProcessIdentity[]
): Promise<Map<number, boolean>> {
  if (process.platform === 'win32' && identities.length <= TARGETED_LIVENESS_MAX_PIDS) {
    const entries = await Promise.all(
      identities.map(async (identity): Promise<[number, boolean]> => {
        const current = await readProcessRow(identity.pid)
        return [identity.pid, current !== null && current.startedAtMs === identity.startedAtMs]
      })
    )
    return new Map(entries)
  }
  const rowsByPid = new Map((await readProcessRows()).map((row) => [row.pid, row]))
  return new Map(
    identities.map((identity) => {
      const current = rowsByPid.get(identity.pid)
      return [identity.pid, current !== undefined && current.startedAtMs === identity.startedAtMs]
    })
  )
}

export async function recordProcessTree(
  root: RecordedProcessIdentity
): Promise<RecordedProcessIdentity[]> {
  const rows = await readProcessRows()
  const currentRoot = rows.find((row) => row.pid === root.pid)
  if (!currentRoot || currentRoot.startedAtMs !== root.startedAtMs) {
    throw new Error(`Fixture root pid ${root.pid} changed incarnation before tree capture`)
  }

  const childrenByParent = new Map<number, ProcessRow[]>()
  for (const row of rows) {
    const children = childrenByParent.get(row.parentPid) ?? []
    children.push(row)
    childrenByParent.set(row.parentPid, children)
  }
  const recorded: RecordedProcessIdentity[] = [root]
  const pending = [...(childrenByParent.get(root.pid) ?? [])]
  while (pending.length > 0) {
    const row = pending.pop()
    if (!row) {
      continue
    }
    recorded.push({ pid: row.pid, startedAtMs: row.startedAtMs })
    pending.push(...(childrenByParent.get(row.pid) ?? []))
  }
  return recorded
}

async function terminateRecordedProcess(identity: RecordedProcessIdentity): Promise<void> {
  try {
    if (process.platform === 'win32') {
      await execFileAsync('taskkill', ['/pid', String(identity.pid), '/f'], processQueryOptions)
    } else {
      process.kill(identity.pid, 'SIGKILL')
    }
  } catch {
    // The exact process incarnation may exit between validation and signalling.
  }
}

export async function terminateRecordedTree(identities: RecordedProcessIdentity[]): Promise<void> {
  const unique = [...new Map(identities.map((identity) => [identity.pid, identity])).values()]
  for (const identity of unique.toReversed()) {
    // Why: PID reuse between tree capture and cleanup must never authorize a
    // signal to a process incarnation the fixture did not create.
    if (!(await processIdentityIsAlive(identity))) {
      continue
    }
    await terminateRecordedProcess(identity)
  }
  await waitForCondition(
    'recorded fixture process tree to be absent',
    async () => {
      const liveness = await processIdentityLiveness(unique)
      return unique.every((identity) => !liveness.get(identity.pid))
    },
    5_000
  )
}
