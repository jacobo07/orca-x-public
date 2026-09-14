import { DaemonClient } from './client'
import { PROTOCOL_VERSION } from './types'

/** Why a reason: "holds work" (preserve) and "cannot answer" (fall back) need opposite decisions. */
export type RetireIfNoLiveWorkReason =
  | 'retiring'
  | 'live_sessions'
  | 'create_in_flight'
  | 'not_retirable'

export type RetireIfNoLiveWorkResult = {
  retiring: boolean
  reason: RetireIfNoLiveWorkReason
}

/**
 * What the daemon said, or why it could not be asked.
 *
 * 'unsupported' and 'unreachable' are both non-answers and neither may license destruction, but
 * they are different facts about the world and only one of them is fixed by updating a peer.
 * Collapsing them once made a daemon nobody could connect to read as an old daemon.
 */
export type AtomicRetirementOutcome =
  | RetireIfNoLiveWorkResult
  | { retiring: false; reason: 'unsupported' }
  | { retiring: false; reason: 'unreachable' }

/** Whether the daemon itself answered. Only an answer is evidence about live work. */
export function atomicRetirementWasAnswered(
  outcome: AtomicRetirementOutcome
): outcome is RetireIfNoLiveWorkResult {
  return outcome.reason !== 'unsupported' && outcome.reason !== 'unreachable'
}

/**
 * Asks the daemon to retire itself if and only if it owns no live work.
 *
 * Why this exists rather than another session count: a count is evidence about the past. Between
 * the daemon answering and the caller signalling, the daemon is still admitting, so a session
 * created in that gap is destroyed by an authorization that was true when it was taken. Only the
 * daemon can prove emptiness and stop admitting in the same event-loop turn.
 *
 * 'unsupported' is deliberately distinct from a refusal: a daemon that predates this request
 * throws 'Unknown request type', and an unreachable one cannot answer at all. Neither tells us
 * anything about live work, so neither may be read as one. Old peers therefore fail CLOSED on the
 * capability -- they never silently accept a request that would skip the check.
 */
export async function requestAtomicRetirement(
  socketPath: string,
  tokenPath: string,
  protocolVersion = PROTOCOL_VERSION
): Promise<AtomicRetirementOutcome> {
  const client = new DaemonClient({ socketPath, tokenPath, protocolVersion })
  try {
    await client.ensureConnected()
  } catch {
    // Nothing answered, so nothing was refused: this says nothing about the peer's age.
    client.disconnect()
    return { retiring: false, reason: 'unreachable' }
  }
  try {
    return await client.request<RetireIfNoLiveWorkResult>('retireIfNoLiveWork', undefined)
  } catch (error) {
    // Measured against the real pre-atomic build 85c15d6da: the daemon's own dispatch throws
    // 'Unknown request type: retireIfNoLiveWork'. Anything else reached a peer that knows the
    // request and failed mid-flight, which is a transport fault, not an old daemon.
    return {
      retiring: false,
      reason: String(error instanceof Error ? error.message : error).includes('Unknown request type')
        ? 'unsupported'
        : 'unreachable'
    }
  } finally {
    client.disconnect()
  }
}
