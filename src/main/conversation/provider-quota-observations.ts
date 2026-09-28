// The last quota state each provider REPORTED, read by routing. Nothing here is inferred: until a
// provider has said something, its quota is `unobserved`, which routing treats as worth trying —
// a call is the only way to learn it, so refusing on silence would never learn anything.
import type { ProviderType } from '../../shared/agent-status-types'

/** Provider wording normalized into what routing needs. Claude reports `allowed`, `allowed_warning`
 *  (measured), and a refusal word not yet observed here — so anything else counts as exhausted. */
export type QuotaState =
  | { state: 'unobserved' }
  | { state: 'ok'; utilization: number | null }
  | { state: 'warning'; utilization: number | null; resetsAtMs: number | null }
  | { state: 'exhausted'; resetsAtMs: number | null; reported: string }

type Observation = {
  status: string
  utilization: number | null
  resetsAtMs: number | null
  observedAtMs: number
}

/** An exhaustion with no reset time is re-tried after this long rather than blocked forever. */
const UNDATED_EXHAUSTION_MS = 60 * 60 * 1000

export class ProviderQuotaObservations {
  private readonly latest = new Map<ProviderType, Observation>()

  record(
    provider: ProviderType,
    observation: { status: string; utilization: number | null; resetsAtMs: number | null },
    now: number
  ): void {
    this.latest.set(provider, { ...observation, observedAtMs: now })
  }

  read(provider: ProviderType, now: number): QuotaState {
    const observed = this.latest.get(provider)
    if (!observed) {
      return { state: 'unobserved' }
    }
    if (observed.status === 'allowed') {
      return { state: 'ok', utilization: observed.utilization }
    }
    if (observed.status === 'allowed_warning') {
      return { state: 'warning', utilization: observed.utilization, resetsAtMs: observed.resetsAtMs }
    }
    const until = observed.resetsAtMs ?? observed.observedAtMs + UNDATED_EXHAUSTION_MS
    // Past its own reset, the refusal describes a window that has closed.
    return until <= now
      ? { state: 'unobserved' }
      : { state: 'exhausted', resetsAtMs: observed.resetsAtMs, reported: observed.status }
  }
}
