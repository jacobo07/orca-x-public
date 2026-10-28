import type { HostConnectivityState, HostObserved } from './host-availability'
import { isHostKey } from './host-wake'
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

function isGrantedTarget(
  entry: unknown
): entry is Record<string, unknown> & { targetId: string; label: string } {
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

// Why separate from WAKE_PROXY_UNKNOWN_REASONS: those say whether a broker can proxy, these say where to send.
export const HOST_WAKE_ROUTE_REASONS = [
  'no_host_key',
  'no_bound_target',
  'ambiguous_broker'
] as const

export type HostWakeRouteReason = (typeof HOST_WAKE_ROUTE_REASONS)[number]

export type WakeRouteBroker = { brokerHostId: string; inputs: WakeProxyInputs }

export type HostWakeRoute =
  | { send: true; brokerHostId: string; targetId: string; observedAt: number }
  | { send: false; reason: HostWakeRouteReason }

type RouteMatch = { brokerHostId: string; targetId: string; observedAt: number }

// Why isHostKey on the entry too: a malformed broker value must never match, whatever the card holds.
function boundTargetIds(targets: unknown, hostKey: string): string[] {
  if (!Array.isArray(targets)) {
    return []
  }
  return targets.flatMap((entry: unknown) =>
    isGrantedTarget(entry) && isHostKey(entry.hostKey) && entry.hostKey === hostKey
      ? [entry.targetId]
      : []
  )
}

// Why per broker: only an answer proven current this session may name a target (D-03).
function collectRouteMatches(
  targetHostId: string,
  hostKey: string,
  brokers: readonly WakeRouteBroker[]
): RouteMatch[] {
  return brokers.flatMap((broker) => {
    if (broker.brokerHostId === targetHostId) {
      return []
    }
    const observed = composeWakeProxyAvailability(broker.inputs)
    if (observed.value !== 'wake-proxy-available') {
      return []
    }
    const { observedAt } = observed.evidence
    return boundTargetIds(broker.inputs.targets?.targets, hostKey).map((targetId) => ({
      brokerHostId: broker.brokerHostId,
      targetId,
      observedAt
    }))
  })
}

// Why: label, targetId, IP and runtimeId never route; only an exact hostKey from this session's answers does.
export function composeHostWakeRoute(input: {
  targetHostId: string
  hostKey: string | null
  brokers: readonly WakeRouteBroker[]
}): HostWakeRoute {
  if (!isHostKey(input.hostKey)) {
    return { send: false, reason: 'no_host_key' }
  }
  const matches = collectRouteMatches(input.targetHostId, input.hostKey, input.brokers)
  if (matches.length === 0) {
    return { send: false, reason: 'no_bound_target' }
  }
  // Why: guessing which broker (most recent, first listed) is refused; two bindings yield no control (D-04).
  if (matches.length > 1) {
    return { send: false, reason: 'ambiguous_broker' }
  }
  return { send: true, ...matches[0] }
}

// Same text and size rules as fingerprintHostPublicKey (src/main/runtime/host-key-fingerprint.ts).
const HOST_PUBLIC_KEY_TEXT = /^[A-Za-z0-9+/]+={0,2}$/
const HOST_PUBLIC_KEY_BYTES = 32

// Why re-pad: Buffer ignores padding but atob demands it; a dangling sextet never completes 32 bytes.
function decodeHostPublicKey(publicKeyB64: string): Uint8Array | null {
  const data = publicKeyB64.replace(/=+$/, '')
  if (data.length % 4 === 1) {
    return null
  }
  const binary = atob(data.padEnd(Math.ceil(data.length / 4) * 4, '='))
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// Why the digest is a parameter: sha256 is node:crypto on the host and @noble/hashes on the phone.
export function hostKeyFromPublicKeyB64(
  publicKeyB64: string,
  digest: (bytes: Uint8Array) => Uint8Array
): string | null {
  if (!HOST_PUBLIC_KEY_TEXT.test(publicKeyB64)) {
    return null
  }
  const bytes = decodeHostPublicKey(publicKeyB64)
  return bytes?.length === HOST_PUBLIC_KEY_BYTES ? encodeBase64Url(digest(bytes)) : null
}
