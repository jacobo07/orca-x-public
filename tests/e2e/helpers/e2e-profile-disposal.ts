// The one way a real-app E2E disposes its temp profile. Order is the contract: owned processes are
// proven gone from the process table BEFORE the directory is touched, because a directory that
// deletes proves nothing about processes on POSIX, and a lock on Windows is only transient once
// nothing owns it. Then a bounded backoff that retries only lock errors, and an explicit answer.
import { execFileSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { CLEANUP_FAILURE_MARKER } from './e2e-precondition'
import { cleanupE2EDaemons, readDaemonPidFiles } from './electron-process-shutdown'

export type E2EProfileDisposal =
  | { state: 'CLEANUP_SUCCEEDED'; elapsedMs: number; attempts: number }
  /** Deleted, but only after Windows released a handle: not a failure, recorded so drift shows. */
  | { state: 'TRANSIENT_LOCK_OBSERVED'; elapsedMs: number; attempts: number; code: string }
  | { state: 'CLEANUP_BLOCKED'; elapsedMs: number; attempts: number; code: string }
  | { state: 'PROCESS_STILL_ALIVE'; elapsedMs: number; pids: number[] }

// Why these three: what Windows returns while another process still holds a handle in the tree.
// Anything else (EACCES on a read-only file, ENOENT races aside) will not fix itself by waiting.
const TRANSIENT_LOCK_CODES = new Set(['EPERM', 'EBUSY', 'ENOTEMPTY'])
const DEFAULT_DEADLINE_MS = 15_000
const PROCESS_EXIT_WAIT_MS = 5_000

export type E2EProfileDisposalDeps = {
  isAlive?: (pid: number) => boolean
  remove?: (dir: string) => void
  /** Pids of live processes whose command line names `dir`. Asked only once deletion has failed. */
  findHolders?: (dir: string) => number[]
  reapDaemons?: (dir: string) => Promise<void>
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means it exists and belongs to someone else: alive, and not ours to call gone.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function findProcessesNaming(dir: string): number[] {
  const self = process.pid
  if (process.platform === 'win32') {
    const needle = dir.replaceAll("'", "''")
    const out = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        // Why `-ne $PID`: this query's own command line contains the needle.
        `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.Contains('${needle}') } | ForEach-Object { $_.ProcessId }`
      ],
      { encoding: 'utf8', timeout: 20_000 }
    )
    return out.split(/\r?\n/).map(Number).filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== self)
  }
  const out = execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' })
  return out
    .split('\n')
    .filter((line) => line.includes(dir))
    .map((line) => Number(line.trim().split(/\s+/)[0]))
    .filter((pid) => Number.isInteger(pid) && pid !== self)
}

export async function disposeE2EProfile(
  dir: string,
  options: { ownedPids?: readonly number[]; deadlineMs?: number } = {},
  deps: E2EProfileDisposalDeps = {}
): Promise<E2EProfileDisposal> {
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const isAlive = deps.isAlive ?? pidIsAlive
  const remove = deps.remove ?? ((target) => rmSync(target, { recursive: true, force: true }))
  const started = now()
  const elapsed = (): number => now() - started

  // Read before reaping: the pid files live inside the directory this is about to delete.
  const owned = [...(options.ownedPids ?? []), ...readDaemonPidFiles(dir)]
  await (deps.reapDaemons ?? cleanupE2EDaemons)(dir)
  for (let waited = 0; owned.some(isAlive) && waited < PROCESS_EXIT_WAIT_MS; waited += 100) {
    await sleep(100)
  }
  const survivors = owned.filter(isAlive)
  if (survivors.length > 0) {
    // Not deleted on purpose: the profile is the evidence of what the survivor was doing.
    return { state: 'PROCESS_STILL_ALIVE', elapsedMs: elapsed(), pids: survivors }
  }

  const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS
  let attempts = 0
  let lockCode: string | null = null
  for (let backoff = 50; ; backoff = Math.min(backoff * 2, 1_000)) {
    attempts += 1
    try {
      remove(dir)
      return lockCode === null
        ? { state: 'CLEANUP_SUCCEEDED', elapsedMs: elapsed(), attempts }
        : { state: 'TRANSIENT_LOCK_OBSERVED', elapsedMs: elapsed(), attempts, code: lockCode }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? 'UNKNOWN'
      if (!TRANSIENT_LOCK_CODES.has(code) || elapsed() >= deadlineMs) {
        const holders = (deps.findHolders ?? findProcessesNaming)(dir)
        return holders.length > 0
          ? { state: 'PROCESS_STILL_ALIVE', elapsedMs: elapsed(), pids: holders }
          : { state: 'CLEANUP_BLOCKED', elapsedMs: elapsed(), attempts, code }
      }
      lockCode = code
      await sleep(Math.min(backoff, Math.max(deadlineMs - elapsed(), 0)))
    }
  }
}

/** Logs every result and returns a marked message for the two that are real residue, else null.
 *  Helpers called from a spec's `finally` pass it to `expect.soft(...).toBeNull()`: residue fails
 *  the test without replacing a body failure, across every spec, with no spec edits. */
export function e2eProfileResidue(label: string, result: E2EProfileDisposal): string | null {
  console.log(`[e2e-cleanup] ${label} ${JSON.stringify(result)}`)
  return result.state === 'PROCESS_STILL_ALIVE' || result.state === 'CLEANUP_BLOCKED'
    ? `${CLEANUP_FAILURE_MARKER} ${label}: ${JSON.stringify(result)}`
    : null
}

/** Throwing form, for fixture teardown, where Playwright reports the error beside the body's. */
export function assertE2EProfileDisposed(label: string, result: E2EProfileDisposal): void {
  const residue = e2eProfileResidue(label, result)
  if (residue) {
    throw new Error(residue)
  }
}
