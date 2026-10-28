import type { HostConnectivityState, HostObserved } from './host-availability'
import { HOST_WAKE_BROKER_RUNTIME_CAPABILITY } from './protocol-version'

export type WakeProxyInputs = {
  broker: { connected: boolean; lastConnectedAt: number | null }
  status: { observedAt: number; result: unknown } | null
  targets: { observedAt: number; targets: unknown } | null
}

export const WAKE_PROXY_UNKNOWN_REASONS = [
  'broker_not_connected',
  'no_status_this_session',
  'status_unreadable',
  'broker_not_announced',
  'no_targets_this_session',
  'targets_unreadable',
  'no_granted_target'
] as const

export type WakeProxyUnknownReason = (typeof WAKE_PROXY_UNKNOWN_REASONS)[number]

export type WakeProxyObservation = HostObserved<
  Extract<HostConnectivityState, 'wake-proxy-available'>
>

export type WakeRequestPlan = { send: true } | { send: false; reason: string }

function unknownProxy(reason: WakeProxyUnknownReason): WakeProxyObservation {
  return { value: 'unknown', evidence: null, reason }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// Why: the card presenter's currency rule; an answer from before the latest connect proves nothing now.
function isCurrent(observedAt: number, lastConnectedAt: number): boolean {
  return Number.isFinite(observedAt) && observedAt >= lastConnectedAt
}

function isGrantedTarget(entry: unknown): boolean {
  return isRecord(entry) && typeof entry.targetId === 'string' && typeof entry.label === 'string'
}

// Why: unknown is never unreachable, never powered off and never woken (D-05).
// No UI consumer until the deferred mobile Wake control (19 D-13): UNIT, wired but unrendered.
export function composeWakeProxyAvailability(inputs: WakeProxyInputs): WakeProxyObservation {
  const { broker, status, targets } = inputs
  if (!broker.connected || broker.lastConnectedAt === null) {
    return unknownProxy('broker_not_connected')
  }
  if (status === null || !isCurrent(status.observedAt, broker.lastConnectedAt)) {
    return unknownProxy('no_status_this_session')
  }
  if (!isRecord(status.result) || !Array.isArray(status.result.capabilities)) {
    return unknownProxy('status_unreadable')
  }
  if (!status.result.capabilities.includes(HOST_WAKE_BROKER_RUNTIME_CAPABILITY)) {
    return unknownProxy('broker_not_announced')
  }
  if (targets === null || !isCurrent(targets.observedAt, broker.lastConnectedAt)) {
    return unknownProxy('no_targets_this_session')
  }
  if (!Array.isArray(targets.targets)) {
    return unknownProxy('targets_unreadable')
  }
  if (!targets.targets.some(isGrantedTarget)) {
    return unknownProxy('no_granted_target')
  }
  return {
    value: 'wake-proxy-available',
    evidence: {
      kind: 'live-response',
      observedAt: Math.min(status.observedAt, targets.observedAt)
    }
  }
}

export function planWakeRequest(observation: WakeProxyObservation): WakeRequestPlan {
  return observation.value === 'wake-proxy-available'
    ? { send: true }
    : { send: false, reason: observation.reason }
}
