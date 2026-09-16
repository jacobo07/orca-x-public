import type { ProcessPresenceProbe } from '../../../shared/process-stats-types'
import type { AgentSleepResult } from './agent-hibernation-coordinator'
import type { SleepAuthorizationSubject } from './agent-sleep-authorization-plan'
import {
  listBaselinePids,
  measureObservedReclaim,
  type ObservedReclaim,
  type SleepReclaimFootprint
} from './agent-sleep-reclaim-projection'

/**
 * After an explicit sleep: what did the processes of the panes that actually
 * slept do? Observation only — it runs after the effect and cannot change it.
 * One uncoalesced sweep per action, and none when nothing slept.
 */

// Why: generous against a 5 s CIM timeout plus the Typeperf fallback; a stalled
// IPC must end as "unavailable", never hold the result hostage.
const PROBE_TIMEOUT_MS = 20_000

export type ProbeProcessPresence = (pids: number[]) => Promise<ProcessPresenceProbe | null>

export type ObserveReclaimAfterSleep = (args: {
  subjects: readonly SleepAuthorizationSubject[]
  results: readonly AgentSleepResult[]
  effectEndedAt: number
}) => Promise<ObservedReclaim>

export function createReclaimObserver(probe: ProbeProcessPresence): ObserveReclaimAfterSleep {
  return async ({ subjects, results, effectEndedAt }) => {
    const footprintByCandidate = new Map<string, SleepReclaimFootprint>()
    for (const subject of subjects) {
      if (subject.authorization) {
        footprintByCandidate.set(subject.authorization.candidateId, subject.footprint)
      }
    }
    const slept: SleepReclaimFootprint[] = []
    for (const result of results) {
      const footprint = footprintByCandidate.get(result.candidateId)
      if (result.outcome === 'slept' && footprint) {
        slept.push(footprint)
      }
    }
    const pids = listBaselinePids(slept)
    const observed = pids.length === 0 ? null : await probe(pids)
    return measureObservedReclaim({ slept, probe: observed, effectEndedAt })
  }
}

export const probeProcessPresenceViaIpc: ProbeProcessPresence = async (pids) => {
  const request = window.api?.memory?.probeProcessPresence
  if (typeof request !== 'function') {
    return null
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      request(pids),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), PROBE_TIMEOUT_MS)
      })
    ])
  } catch (err) {
    console.warn('[sleep] post-effect presence probe failed', err)
    return null
  } finally {
    clearTimeout(timer)
  }
}

export const observeReclaimAfterSleep = createReclaimObserver(probeProcessPresenceViaIpc)
