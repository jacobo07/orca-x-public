import { readFileSync } from 'node:fs'
import { getDaemonPidPath } from './daemon-spawner'
import { parseDaemonPidFile, type ParsedDaemonPid } from './daemon-pid-file-parse'
import { getPsProcessIdentityAsync } from './daemon-process-identity-query'
import { queryWindowsProcess } from './daemon-process-inspection'
import {
  START_TIME_TOLERANCE_MS,
  startTimeMatches,
  startTimesWithinTolerance
} from './daemon-process-start-time'
import { PROTOCOL_VERSION } from './types'

// Why: on Windows the pid file's startedAtMs is the daemon's self-reported
// Node start time, while verification reads the OS process creation time —
// the gap between them is the exe bootstrap, which AV/disk pressure can
// stretch to seconds. Pid recycling differs by minutes-to-days, so a wide
// tolerance keeps the guard effective without false mismatches.
const WIN32_START_TIME_TOLERANCE_MS = 10_000

export function commandLineMatchesDaemon(
  commandLine: string,
  socketPath: string,
  tokenPath: string
): boolean {
  return (
    commandLine.includes('daemon-entry') &&
    commandLine.includes(socketPath) &&
    commandLine.includes(tokenPath)
  )
}

export function isNoSuchProcessError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH'
}

/**
 * Four answers, and three of them are positive observations.
 *
 * 'mismatch' — a process holds the pid and it is not our daemon.
 * 'absent'   — nothing holds the pid. The OS answered; this is evidence, not a shrug.
 * 'unknown'  — the instrument could not tell us. Load-bearing: a failed inspection is not
 *   evidence that the recorded pid is someone else's. `ps` runs under a 2s budget and
 *   PowerShell CIM under 3s, and a loaded machine blows both — reading that as "not our
 *   daemon" is what authorized reclaiming a live daemon's ownership in the first place.
 *
 * 'absent' and 'mismatch' happen to lead to the same destructive decision today (neither may
 * be signalled), but they are different facts and the logs must not claim one for the other.
 */
export type DaemonProcessIdentity = 'match' | 'mismatch' | 'absent' | 'unknown'

/**
 * The verdict together with the command line it was computed from.
 *
 * Why the command line rides along: reading it is the expensive half — a powershell.exe CIM
 * spawn on Windows, a `ps` spawn on darwin. The launch-identity check below needs the same
 * bytes, and fetching them a second time from a second process is the same question asked
 * twice. The verdict alone is what every other caller wants, so that stays the exported shape.
 */
type DaemonIdentityObservation = {
  verdict: DaemonProcessIdentity
  commandLine: string | null
}

async function observeDaemonProcessIdentity(
  pid: number,
  socketPath: string,
  tokenPath: string,
  startedAtMs: number | null
): Promise<DaemonIdentityObservation> {
  try {
    process.kill(pid, 0)
  } catch (error) {
    // Why: only ESRCH proves the process is gone — and "gone" is absence, not a process that
    // turned out to be someone else's. EPERM means it exists and belongs to another user;
    // reading that as absence deletes a live daemon's ownership.
    return {
      verdict: isNoSuchProcessError(error) ? 'absent' : 'unknown',
      commandLine: null
    }
  }

  const observed = (matches: boolean, commandLine: string): DaemonIdentityObservation => ({
    verdict: matches ? 'match' : 'mismatch',
    commandLine
  })

  if (process.platform === 'win32') {
    // Why this query and not the lighter sibling: on Windows a terminated process keeps its pid
    // reserved while any handle to it survives, so the liveness check above can pass for a
    // process Win32_Process no longer lists. Only a query that reports absence separately from
    // its own failure can tell those apart, and the difference decides whether a daemon is
    // replaced or preserved into degraded mode.
    const identity = await queryWindowsProcess(pid)
    if (identity.status === 'missing') {
      return { verdict: 'absent', commandLine: null }
    }
    if (identity.status !== 'present' || identity.commandLine === null) {
      // Present-but-unreadable is still unknown: without the command line there is nothing to
      // bind this pid to our daemon, and an unbound pid must never be signalled.
      return { verdict: 'unknown', commandLine: null }
    }
    // Why: image names are too broad after PID reuse. Match the daemon entry
    // plus the exact socket/token args so we only kill the daemon for this
    // userData protocol endpoint.
    return observed(
      commandLineMatchesDaemon(identity.commandLine, socketPath, tokenPath) &&
        startTimesWithinTolerance(identity.startedAtMs, startedAtMs, WIN32_START_TIME_TOLERANCE_MS),
      identity.commandLine
    )
  }

  try {
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8')
    return observed(
      commandLineMatchesDaemon(cmdline, socketPath, tokenPath) && startTimeMatches(pid, startedAtMs),
      cmdline
    )
  } catch {
    const identity = await getPsProcessIdentityAsync(pid)
    if (!identity) {
      return { verdict: 'unknown', commandLine: null }
    }
    return observed(
      commandLineMatchesDaemon(identity.commandLine, socketPath, tokenPath) &&
        startTimesWithinTolerance(identity.startedAtMs, startedAtMs, START_TIME_TOLERANCE_MS),
      identity.commandLine
    )
  }
}

export async function inspectDaemonProcessIdentity(
  pid: number,
  socketPath: string,
  tokenPath: string,
  startedAtMs: number | null
): Promise<DaemonProcessIdentity> {
  return (await observeDaemonProcessIdentity(pid, socketPath, tokenPath, startedAtMs)).verdict
}

export type DaemonLaunchIdentity = 'match' | 'mismatch' | 'unknown'

/**
 * Why the verdict rides along instead of collapsing to a nullable record: 'mismatch' and
 * 'unknown' are opposite evidence. One says the recorded pid provably is not our daemon; the
 * other says a loaded machine could not tell. Only the first may be remembered.
 */
type DaemonPidObservation = {
  verdict: DaemonProcessIdentity
  parsed: ParsedDaemonPid | null
  commandLine: string | null
}

/**
 * Why a memo here and not at each caller: startup asks this same question of the same record
 * twice in a row — the launch-identity check and the bundle-staleness check — and each answer
 * costs a subprocess. Keyed on the record's own bytes, so a daemon that changes invalidates it
 * rather than being answered from its predecessor's evidence.
 *
 * Deliberately NOT reachable from the destructive path: killStaleDaemon and its pre-SIGKILL
 * recheck call inspectDaemonProcessIdentity directly, never through here. That is structural,
 * not a convention — a signal must be authorized against a fresh observation, because between
 * a read-only check and the signal the daemon can die and its pid be recycled.
 */
const VERIFIED_PID_MEMO_TTL_MS = 5_000

let verifiedPidMemo: {
  key: string
  expiresAtMs: number
  pending: Promise<DaemonPidObservation>
} | null = null

const UNREADABLE_PID_RECORD: DaemonPidObservation = {
  verdict: 'mismatch',
  parsed: null,
  commandLine: null
}

async function observeRecordedDaemonPid(
  runtimeDir: string,
  socketPath: string,
  tokenPath: string,
  protocolVersion: number
): Promise<DaemonPidObservation> {
  let contents: string
  try {
    contents = readFileSync(getDaemonPidPath(runtimeDir, protocolVersion), 'utf8')
  } catch {
    return UNREADABLE_PID_RECORD
  }

  const key = JSON.stringify([runtimeDir, socketPath, tokenPath, protocolVersion, contents])
  const now = Date.now()
  if (verifiedPidMemo?.key === key && verifiedPidMemo.expiresAtMs > now) {
    return await verifiedPidMemo.pending
  }

  const pending = (async (): Promise<DaemonPidObservation> => {
    const parsed = parseDaemonPidFile(contents)
    if (!parsed) {
      return UNREADABLE_PID_RECORD
    }
    const observation = await observeDaemonProcessIdentity(
      parsed.pid,
      socketPath,
      tokenPath,
      parsed.startedAtMs
    )
    return { verdict: observation.verdict, parsed, commandLine: observation.commandLine }
  })()
  verifiedPidMemo = { key, expiresAtMs: now + VERIFIED_PID_MEMO_TTL_MS, pending }

  const observation = await pending
  // Why only 'unknown' is forgotten: it is the one verdict that says nothing about the subject.
  // A loaded machine blows the 2-3s inspection budget, and remembering that for the rest of the
  // window is how a live daemon stops being recognized. 'match' and 'mismatch' are real
  // observations of a record that has not changed, so one answer serves both readers.
  if (observation.verdict === 'unknown' && verifiedPidMemo?.pending === pending) {
    verifiedPidMemo = null
  }
  return observation
}

export async function getDaemonLaunchIdentity(
  runtimeDir: string,
  socketPath: string,
  tokenPath: string,
  expectedEntryPath: string,
  protocolVersion = PROTOCOL_VERSION
): Promise<DaemonLaunchIdentity> {
  const verified = await observeRecordedDaemonPid(
    runtimeDir,
    socketPath,
    tokenPath,
    protocolVersion
  )
  if (verified.verdict !== 'match' || !verified.parsed) {
    return 'unknown'
  }

  if (verified.parsed.entryPath) {
    return verified.parsed.entryPath === expectedEntryPath ? 'match' : 'mismatch'
  }

  // Why: older pid files did not persist entryPath. The command line still carries
  // daemon-entry.js, so use it to stop dev worktrees from reusing a daemon forked from a
  // deleted sibling checkout. It is the same command line the verification above already
  // matched against, so this costs nothing; if it was never read, fail open so we don't kill
  // live sessions unnecessarily.
  if (!verified.commandLine) {
    return 'unknown'
  }
  return verified.commandLine.includes(expectedEntryPath) ? 'match' : 'mismatch'
}

export async function readVerifiedDaemonPid(
  runtimeDir: string,
  socketPath: string,
  tokenPath: string,
  protocolVersion = PROTOCOL_VERSION
): Promise<ParsedDaemonPid | null> {
  const observation = await observeRecordedDaemonPid(
    runtimeDir,
    socketPath,
    tokenPath,
    protocolVersion
  )
  return observation.verdict === 'match' ? observation.parsed : null
}
