import { HOST_AVAILABILITY_RUNTIME_CAPABILITY } from './protocol-version'

export const HOST_EVIDENCE_KINDS = [
  'live-response',
  'transport-observed',
  'host-announced',
  'relay-reported',
  'os-probe'
] as const
export type HostEvidenceKind = (typeof HOST_EVIDENCE_KINDS)[number]
export type HostEvidence = { kind: HostEvidenceKind; observedAt: number }

export const HOST_POWER_STATES = [
  'awake',
  'sleeping',
  'hibernating',
  'powered-off',
  'unknown',
  'unobservable'
] as const
export const HOST_ORCA_STATES = [
  'service-ready',
  'runtime-ready',
  'ui-open',
  'ui-closed',
  'starting',
  'version-mismatch',
  'unavailable',
  'unknown'
] as const
export const HOST_CONNECTIVITY_STATES = [
  'normal',
  'warning',
  'unreachable',
  'auth-failed',
  'wake-proxy-available',
  'oob-available'
] as const
export type HostPowerState = (typeof HOST_POWER_STATES)[number]
export type HostOrcaState = (typeof HOST_ORCA_STATES)[number]
export type HostConnectivityState = (typeof HOST_CONNECTIVITY_STATES)[number]

export type HostObserved<S extends string> =
  | { value: Exclude<S, 'unknown'>; evidence: HostEvidence; detail?: string }
  | { value: 'unknown'; evidence: null; reason: string }

export type HostAvailability = {
  power: HostObserved<HostPowerState>
  orca: HostObserved<HostOrcaState>
  connectivity: { value: HostConnectivityState; evidence: HostEvidence }
}

export type HostProcessKind = 'serve' | 'desktop'

export type HostStatusObservation = {
  observedAt: number
  protocolCompatible: boolean
  graphStatus?: string
  desktopWindowStatus?: string
  processKind?: HostProcessKind | null
}

export type HostAvailabilityObservations = {
  transport: {
    verdictKind: 'normal' | 'warning' | 'unreachable' | 'auth-failed'
    connected: boolean
    observedAt: number
  }
  // Why: only the latest status.get answer on the CURRENT connection; an older one proves nothing now.
  status: HostStatusObservation | null
}

function unknownObserved(reason: string): { value: 'unknown'; evidence: null; reason: string } {
  return { value: 'unknown', evidence: null, reason }
}

const CLOSED_WINDOW_STATUSES: readonly string[] = ['openable', 'initializing', 'blocked']

// Why: the window string is host input; only recognized values are echoed as a detail.
function windowDetail(window: string | undefined): string {
  if (window === undefined) {
    return 'window_status_absent'
  }
  return window === 'available' || CLOSED_WINDOW_STATUSES.includes(window)
    ? window
    : 'unrecognized_window_status'
}

function composeReadyOrca(
  status: HostStatusObservation,
  evidence: HostEvidence
): HostObserved<HostOrcaState> {
  const window = status.desktopWindowStatus
  if (window === 'available') {
    return { value: 'ui-open', evidence }
  }
  // Why: a serve host has no window to open, so a ready graph is the whole service (D-03).
  if (status.processKind === 'serve') {
    return { value: 'service-ready', evidence, detail: windowDetail(window) }
  }
  if (window === undefined) {
    return { value: 'runtime-ready', evidence }
  }
  if (CLOSED_WINDOW_STATUSES.includes(window)) {
    return { value: 'ui-closed', evidence, detail: window }
  }
  return { value: 'runtime-ready', evidence, detail: 'unrecognized_window_status' }
}

function composeOrca(status: HostStatusObservation): HostObserved<HostOrcaState> {
  const evidence: HostEvidence = { kind: 'live-response', observedAt: status.observedAt }
  if (!status.protocolCompatible) {
    return { value: 'version-mismatch', evidence }
  }
  if (status.graphStatus === 'unavailable') {
    return { value: 'unavailable', evidence }
  }
  if (status.graphStatus === 'reloading') {
    return { value: 'starting', evidence }
  }
  if (status.graphStatus === 'ready') {
    return composeReadyOrca(status, evidence)
  }
  return unknownObserved('graph_status_unrecognized')
}

export function composeHostAvailability(
  observations: HostAvailabilityObservations
): HostAvailability {
  const { transport, status } = observations
  const connectivity = {
    value: transport.verdictKind,
    evidence: { kind: 'transport-observed', observedAt: transport.observedAt } as HostEvidence
  }
  if (!transport.connected || status === null) {
    // Why: silence is not a power state; no answer only ever composes to unknown (D-02).
    const reason = transport.connected ? 'no_live_response' : 'not_connected'
    return { power: unknownObserved(reason), orca: unknownObserved(reason), connectivity }
  }
  return {
    power: { value: 'awake', evidence: { kind: 'live-response', observedAt: status.observedAt } },
    orca: composeOrca(status),
    connectivity
  }
}

export const HOST_CAPABILITY_IDS = [
  'can-start-orca',
  'can-wake-lan',
  'can-wake-remote',
  'can-power-on-oob',
  'can-relay',
  'can-direct'
] as const
export const HOST_CAPABILITY_VALUES = [
  'supported',
  'not-supported',
  'not-configured',
  'needs-owner-setup',
  'unknown'
] as const
export type HostCapabilityId = (typeof HOST_CAPABILITY_IDS)[number]
export type HostCapabilityValue = (typeof HOST_CAPABILITY_VALUES)[number]

export type HostCapability =
  | { value: Exclude<HostCapabilityValue, 'unknown'>; reason: string; evidence: HostEvidence }
  | { value: 'unknown'; reason: string; evidence: null }

export type HostCapabilitySet = Record<HostCapabilityId, HostCapability>

export type HostAvailabilityAnnouncement = {
  schema: 1
  processKind: HostProcessKind | null
  observedAt: number
  capabilities: HostCapabilitySet
}

export function unknownHostCapabilities(reason: string): HostCapabilitySet {
  const set = {} as HostCapabilitySet
  for (const id of HOST_CAPABILITY_IDS) {
    set[id] = { value: 'unknown', reason, evidence: null }
  }
  return set
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const REASON_PATTERN = /^[a-z0-9_]{1,64}$/

function unknownCapability(reason: string): HostCapability {
  return { value: 'unknown', reason, evidence: null }
}

function parseEvidence(evidence: unknown): HostEvidence | null {
  if (!isRecord(evidence) || !Number.isFinite(evidence.observedAt)) {
    return null
  }
  const kind = HOST_EVIDENCE_KINDS.find((candidate) => candidate === evidence.kind)
  return kind ? { kind, observedAt: evidence.observedAt as number } : null
}

// Why total: the entry is an untrusted host answer, so anything malformed degrades to unknown (T-18-01).
function parseCapability(entry: unknown): HostCapability {
  if (!isRecord(entry)) {
    return unknownCapability('capability_not_announced')
  }
  const value = HOST_CAPABILITY_VALUES.find((candidate) => candidate === entry.value)
  if (!value) {
    return unknownCapability('unrecognized_value')
  }
  const reason =
    typeof entry.reason === 'string' && REASON_PATTERN.test(entry.reason)
      ? entry.reason
      : 'unspecified'
  if (value === 'unknown') {
    return unknownCapability(reason)
  }
  const evidence = parseEvidence(entry.evidence)
  return evidence ? { value, reason, evidence } : unknownCapability('evidence_missing')
}

function ownEntry(record: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined
}

export function parseHostAvailabilityAnnouncement(status: unknown): {
  processKind: HostProcessKind | null
  capabilities: HostCapabilitySet
} {
  if (!isRecord(status)) {
    return { processKind: null, capabilities: unknownHostCapabilities('status_unreadable') }
  }
  const announced =
    Array.isArray(status.capabilities) &&
    status.capabilities.includes(HOST_AVAILABILITY_RUNTIME_CAPABILITY)
  if (!announced) {
    // Why: an old host omits the capability string; its silence reads as unknown (D-05).
    return { processKind: null, capabilities: unknownHostCapabilities('host_did_not_announce') }
  }
  const announcement = status.hostAvailability
  if (!isRecord(announcement) || announcement.schema !== 1) {
    return { processKind: null, capabilities: unknownHostCapabilities('announcement_unreadable') }
  }
  const entries = isRecord(announcement.capabilities) ? announcement.capabilities : {}
  const capabilities = {} as HostCapabilitySet
  for (const id of HOST_CAPABILITY_IDS) {
    capabilities[id] = parseCapability(ownEntry(entries, id))
  }
  const kind = announcement.processKind
  return { processKind: kind === 'serve' || kind === 'desktop' ? kind : null, capabilities }
}
