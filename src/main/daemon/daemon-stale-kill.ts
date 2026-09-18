import { readFileSync } from 'node:fs'
import {
  getDaemonPidPath,
  unlinkDaemonPidFileWhen,
  unlinkOwnedDaemonPidFile
} from './daemon-spawner'
import {
  endpointIsProvenDead,
  probeSocketConnect,
  type SocketProbeOutcome
} from './daemon-endpoint-probe'
import { parseDaemonPidFile, type ParsedDaemonPid } from './daemon-pid-file-parse'
import { inspectDaemonProcessIdentity, isNoSuchProcessError } from './daemon-pid-identity'
import { getAliveDaemonSessionCount } from './daemon-live-session-count'
import { atomicRetirementWasAnswered, requestAtomicRetirement } from './daemon-atomic-retirement'
import { supportsAtomicRetirement } from './daemon-protocol-version'
import { PROTOCOL_VERSION } from './types'

const KILL_WAIT_MS = 3_000
const KILL_POLL_MS = 100
// Why: SIGKILL is delivered on return from an uninterruptible syscall, so confirm the exit
// rather than assume it — but keep the wait short, it only guards the rare wedged case.
const SIGKILL_CONFIRM_WAIT_MS = 1_000

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      process.kill(pid, 0)
    } catch {
      return true
    }
    if (Date.now() >= deadline) {
      return false
    }
    await new Promise((resolve) => setTimeout(resolve, KILL_POLL_MS))
  }
}

export type StaleDaemonKillOptions = {
  /**
   * Direct-construction-only seam. Which errno a non-socket path yields is platform-specific
   * (macOS ENOTSOCK vs Linux refused), so the decision rule below cannot be driven portably
   * through real syscalls. The probe itself is covered separately; this injects its verdict.
   */
  probeEndpoint?: (socketPath: string) => Promise<SocketProbeOutcome>
  /**
   * Set by callers whose destruction was authorized on the belief that no live work exists —
   * automatic replacement — so the belief is re-taken immediately before the signal.
   *
   * Deliberately opt-in. A restart or a quit destroys sessions the user asked to end, and
   * giving those the same refusal would turn an authorized action into an unkillable daemon.
   * Authorized destruction and automatic safe replacement are different contracts.
   */
  preserveLiveWork?: boolean
}

/** @deprecated Use StaleDaemonKillOptions; kept so the name change is not a silent break. */
export type StaleDaemonKillTestHooks = StaleDaemonKillOptions

/**
 * Which authority kept the daemon alive. Preservation is not one outcome: refusing because the
 * daemon itself proved it owns work, and refusing because we could not identify the process at
 * all, are opposite evidence about live work, and only one of them is the safety property.
 *
 * 'atomic_retirement_refused' is reachable ONLY through the daemon-side request, so it is what
 * distinguishes the fenced authority from the legacy count that cannot fence anything.
 */
export type StaleDaemonPreservedBy =
  | 'atomic_retirement_refused'
  | 'atomic_retirement_unsupported_generation'
  | 'live_work_admitted_after_authorization'
  | 'identity_unverifiable'
  | 'signal_refused'
  | 'unconfirmed_exit'
  | 'endpoint_still_serving'

export type StaleDaemonKillOutcome = {
  /** A daemon was positively confirmed gone. Drives replacement telemetry. */
  killed: boolean
  /**
   * We could not prove the recorded daemon is gone. Its PID record and endpoint are left
   * intact and the caller must not fork a replacement beside it — that is exactly how two
   * daemons end up alive with one owning the socket and the other hosting the sessions.
   */
  liveOwnerSurvived: boolean
  /**
   * Why it survived. Absent when nothing survived. Callers that merely need "may I fork?" keep
   * reading liveOwnerSurvived; this says which guard answered, which the log line alone could
   * not be trusted for -- prose is not a contract.
   */
  preservedBy?: StaleDaemonPreservedBy
}

export async function killStaleDaemon(
  runtimeDir: string,
  socketPath: string,
  tokenPath: string,
  protocolVersion = PROTOCOL_VERSION,
  options?: StaleDaemonKillOptions
): Promise<StaleDaemonKillOutcome> {
  const probeEndpoint = options?.probeEndpoint ?? probeSocketConnect
  const pidPath = getDaemonPidPath(runtimeDir, protocolVersion)
  let killedDaemon = false
  let liveOwnerSurvived = false
  // Why: identity is resolved once, and the record we may later remove is captured here so
  // cleanup can be fenced to this exact incarnation rather than to whatever occupies the path
  // by the time we get there.
  let recordedOwner: ParsedDaemonPid | null = null
  try {
    const parsedPid = parseDaemonPidFile(readFileSync(pidPath, 'utf8'))
    recordedOwner = parsedPid
    const identity = parsedPid
      ? await inspectDaemonProcessIdentity(
          parsedPid.pid,
          socketPath,
          tokenPath,
          parsedPid.startedAtMs
        )
      : 'mismatch'
    if (
      parsedPid &&
      identity === 'unknown' &&
      !endpointIsProvenDead(await probeEndpoint(socketPath))
    ) {
      // Why: the inspection failed, which is not evidence that this PID is someone else's.
      // The endpoint is the tiebreaker, and it only settles the question when it positively
      // proves nothing is serving. A probe that merely timed out is not proof either, so
      // two inconclusive signals must preserve ownership rather than combine into a licence.
      console.warn(
        '[daemon] Preserving daemon that could not be inspected: reason=identity_probe_failed'
      )
      return { killed: false, liveOwnerSurvived: true, preservedBy: 'identity_unverifiable' }
    }
    if (parsedPid && identity === 'match') {
      const { pid, startedAtMs } = parsedPid
      // Why here and not at the caller: everything above this line is evidence-gathering, and
      // the identity query alone costs a subprocess (300-800ms on Windows). A session admitted
      // during that gap is invisible to the count that authorized this kill, and the daemon has
      // no idea it is being replaced, so its own admission fence stays open throughout. Re-take
      // the authorization against the state that exists now.
      //
      // Ask the daemon to retire itself first. It is the only party that can prove it owns no
      // work and stop admitting in the same event-loop turn; a count taken here is already
      // stale by the time the signal below is sent, and a session created in that gap dies.
      //
      // Only a positive count refuses in the fallback. null means the daemon could not be
      // asked, a different question already settled upstream with a grace-retry budget
      // (#8689); turning unknown into a refusal here would make a wedged daemon unreplaceable.
      if (options?.preserveLiveWork) {
        // Why decide from the generation before asking: a peer that predates the request answers
        // the same way an unreachable one does, so its reply is not evidence about live work and
        // must never license the count below. Support is a property of the target incarnation,
        // and the generation is the only thing that states it BEFORE the irreversible step —
        // a reply arrives too late to be a safety mechanism.
        //
        // Today the only caller that sets preserveLiveWork targets the current generation, so
        // this cannot fire in production. It is here so the property is structural rather than a
        // coincidence of one call site: the next caller to ask for safe replacement of an older
        // daemon gets a refusal, not a silent downgrade to the racy path.
        if (!supportsAtomicRetirement(protocolVersion)) {
          console.warn(
            `[daemon] Preserving daemon whose generation predates atomic retirement: reason=atomic_retirement_unsupported_generation, protocolVersion=${protocolVersion}`
          )
          return {
            killed: false,
            liveOwnerSurvived: true,
            preservedBy: 'atomic_retirement_unsupported_generation'
          }
        }
        const retirement = await requestAtomicRetirement(socketPath, tokenPath, protocolVersion)
        // Why a positive test rather than excluding the non-answers one by one: the next
        // non-answer added to that union would silently become a live-work refusal here, and a
        // refusal on an unreachable daemon makes a wedged one unreplaceable.
        if (atomicRetirementWasAnswered(retirement) && !retirement.retiring) {
          console.warn(
            `[daemon] Preserving daemon that owns live work: reason=${retirement.reason}`
          )
          return {
            killed: false,
            liveOwnerSurvived: true,
            preservedBy: 'atomic_retirement_refused'
          }
        }
        if (!retirement.retiring) {
          // What is left after the generation guard above: a peer that DOES advertise the
          // capability and still could not answer -- a wedged or mid-flight transport fault.
          // That is not evidence about live work either, so the count is all there is. It is
          // racy, and refusing instead would make a wedged daemon unreplaceable, so the trade
          // is deliberate and narrow: it no longer covers any daemon that is merely old.
          //
          // Why it says so out loud: this is a downgrade from an atomic, admission-fencing
          // authority to a count that cannot fence anything, and a safety property that
          // degrades silently is indistinguishable from one that holds.
          console.warn(
            `[daemon] Falling back to the racy pre-signal count: reason=atomic_retirement_${retirement.reason}`
          )
          const liveSessionCount = await getAliveDaemonSessionCount(
            socketPath,
            tokenPath,
            protocolVersion
          )
          if (liveSessionCount !== null && liveSessionCount > 0) {
            console.warn(
              `[daemon] Preserving daemon that acquired live work before the replacement signal: reason=live_work_admitted_after_authorization, liveSessions=${liveSessionCount}`
            )
            return {
              killed: false,
              liveOwnerSurvived: true,
              preservedBy: 'live_work_admitted_after_authorization'
            }
          }
        }
      }
      try {
        process.kill(pid, 'SIGTERM')
      } catch (error) {
        // Why: ESRCH means it is already gone. Anything else (EPERM from a daemon owned by
        // another user) means it is alive and we cannot stop it — falling through to the
        // blanket catch would report "nothing alive" and authorize a duplicate beside it.
        if (!isNoSuchProcessError(error)) {
          return { killed: false, liveOwnerSurvived: true, preservedBy: 'signal_refused' }
        }
      }
      const deadline = Date.now() + KILL_WAIT_MS
      let exited = false
      while (Date.now() < deadline) {
        try {
          process.kill(pid, 0)
        } catch {
          exited = true
          break
        }
        await new Promise((resolve) => setTimeout(resolve, KILL_POLL_MS))
      }
      if (!exited) {
        // Why: re-check process identity before SIGKILL. The SIGTERM-then-wait
        // window is long enough for the pid to be recycled if the original
        // daemon died during the wait. Without this, we'd SIGKILL an unrelated
        // process that happens to now own the same pid.
        const recheck = await inspectDaemonProcessIdentity(pid, socketPath, tokenPath, startedAtMs)
        if (recheck === 'absent') {
          // Why separate from the recycle case below: both stop the SIGKILL, but one says the
          // pid is now someone else's and this one says nothing holds it at all. Logging the
          // recycle reason for a process that simply exited describes a race that never happened.
          console.warn('[daemon] Skipping SIGKILL for stale daemon: reason=process_gone')
          exited = true
        } else if (recheck === 'mismatch') {
          // Why: the pid provably no longer belongs to our daemon, so it is gone regardless
          // of what the endpoint says.
          console.warn('[daemon] Skipping SIGKILL for stale daemon: reason=pid_recycled')
          exited = true
        } else if (recheck === 'unknown') {
          // Why: the inspection failed under load. Only an endpoint that proves nothing is
          // serving may license reclaiming — a timed-out probe is not a second opinion.
          if (endpointIsProvenDead(await probeEndpoint(socketPath))) {
            console.warn('[daemon] Skipping SIGKILL for stale daemon: reason=pid_recycled')
            exited = true
          } else {
            console.warn(
              '[daemon] Preserving daemon that could not be identified: reason=identity_probe_failed'
            )
            // Why return rather than set the flag: the flag path below short-circuits the
            // pid-file unlink anyway, so this is the same behaviour — and it lets the reason
            // separate "could not identify" from "would not die", which are not the same news.
            return { killed: false, liveOwnerSurvived: true, preservedBy: 'identity_unverifiable' }
          }
        } else {
          try {
            process.kill(pid, 'SIGKILL')
          } catch {
            // Already dead
            exited = true
          }
          // Why: issuing SIGKILL is not proof of death — a process blocked in an
          // uninterruptible syscall only dies once it returns. Claiming the kill without
          // confirming it is what let the endpoint be reclaimed out from under a daemon
          // that was still alive and still serving.
          exited = exited || (await waitForProcessExit(pid, SIGKILL_CONFIRM_WAIT_MS))
          if (!exited) {
            console.warn('[daemon] Daemon survived SIGKILL: reason=unconfirmed_exit')
          }
        }
      }
      killedDaemon = exited
      // Why: SIGTERM and SIGKILL both failed to produce an exit, so the daemon is still out
      // there holding the endpoint. Treat it as the owner rather than racing it.
      liveOwnerSurvived = !exited
    }
  } catch {
    // PID file missing or process already dead
  }

  if (liveOwnerSurvived) {
    // Why: removing the record of a daemon we failed to kill is what let a replacement
    // publish its own ownership beside it. Leaving it intact keeps the exclusive PID claim
    // held, so a duplicate cannot take the endpoint.
    return { killed: killedDaemon, liveOwnerSurvived, preservedBy: 'unconfirmed_exit' }
  }

  // Why: remove only the record belonging to the daemon we just dealt with. An unfenced
  // unlink deletes whatever occupies the path now, which after a slow kill can be a
  // replacement's freshly published ownership.
  if (recordedOwner) {
    unlinkOwnedDaemonPidFile(pidPath, recordedOwner.pid, recordedOwner.launchNonce)
  } else {
    // Why: a record we cannot parse names no owner to fence against, but leaving it in place
    // fails the next daemon's exclusive publish with EEXIST — no daemon at all. Reclaim it
    // under the same rename claim, and only while it is still unparseable, so a valid record
    // published in the meantime is left alone.
    unlinkDaemonPidFileWhen(pidPath, (content) => parseDaemonPidFile(content) === null)
  }

  // Why this only reads: removing an endpoint on another daemon's behalf is the whole defect
  // class this design retires. A replacement takes the name itself, by replacing an entry it
  // has proven dead in one rename. So the only question left here is whether something is
  // still answering — and only a positive answer withholds the fork.
  // An unclassifiable entry is no longer a reason to refuse: the publisher probes again and
  // will not overwrite anything it cannot prove dead, which makes this judgement a hint
  // rather than a correctness dependency.
  if ((await probeEndpoint(socketPath)) === 'connected') {
    return { killed: killedDaemon, liveOwnerSurvived: true, preservedBy: 'endpoint_still_serving' }
  }
  return { killed: killedDaemon, liveOwnerSurvived }
}
