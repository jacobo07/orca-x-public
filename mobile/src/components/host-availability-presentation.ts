import {
  composeHostAvailability,
  HOST_CAPABILITY_IDS,
  parseHostAvailabilityAnnouncement,
  unknownHostCapabilities,
  type HostCapabilitySet,
  type HostCapabilityValue,
  type HostOrcaState,
  type HostPowerState,
  type HostStatusObservation
} from '../../../src/shared/host-availability'
import type { HostWakeRefusalCode, HostWakeStageRecord } from '../../../src/shared/host-wake'
import { composeHostWakeRoute, type WakeRouteBroker } from '../../../src/shared/host-wake-proxy'
import type { ConnectionVerdict } from '../transport/connection-health'
import type { HomeHostStatusSnapshot } from '../transport/home-host-status-fetch'
import { evaluateCompat } from '../transport/protocol-compat'
import { statusReadHidesStage, wakeAttemptFurthestStage } from './host-card-wake-stage'

// The only availability copy the host card can show. A state without a key renders its family's
// unknown label; a key is added only together with a producer that can prove the state.
export const HOST_CARD_LABELS = {
  'power.awake': 'Awake',
  'power.unknown': 'Power unknown',
  'orca.service-ready': 'Host Service running',
  'orca.runtime-ready': 'Orca runtime ready',
  'orca.ui-open': 'Orca open',
  'orca.ui-closed': 'Orca running, window closed',
  'orca.starting': 'Orca starting',
  'orca.version-mismatch': 'Orca version mismatch',
  'orca.unavailable': 'Orca unavailable',
  'orca.unknown': 'Orca unknown',
  'capability.can-start-orca': 'Logon start',
  'capability.can-wake-lan': 'LAN wake',
  'capability.can-wake-remote': 'Remote wake',
  'capability.can-power-on-oob': 'Power-on',
  'capability.can-relay': 'Relay',
  'capability.can-direct': 'Direct',
  'capability-value.supported': 'yes',
  'capability-value.not-supported': 'not possible',
  'capability-value.not-configured': 'not set up',
  'capability-value.needs-owner-setup': 'needs setup',
  'capability-value.unknown': 'unknown',
  'capabilities.unknown': 'Capabilities unknown',
  'wake.requested': 'Wake requested',
  'wake.authorized': 'Wake authorized',
  'wake.packet-sent': 'Wake packet sent',
  'wake.packet-send-failed': 'Wake packet not sent',
  'wake.host-announced': 'Host answered after wake',
  'wake.runtime-ready': 'Orca runtime ready after wake',
  'wake.wake_broker_disabled': 'Wake refused: broker not enabled',
  'wake.wake_broker_unavailable': 'Wake refused: broker unavailable',
  'wake.wake_device_required': 'Wake refused: paired device required',
  'wake.wake_device_revoked': 'Wake refused: device revoked',
  'wake.wake_device_unauthorized': 'Wake refused: device not authorized',
  'wake.wake_device_unknown': 'Wake refused: device unknown to broker',
  'wake.wake_grant_missing': 'Wake refused: no grant',
  'wake.wake_target_unknown': 'Wake refused: target unknown',
  'wake.wake_target_rebound': 'Wake refused: target bound to another host',
  'wake.wake_send_failed': 'Wake refused: send failed',
  'wake.wake_unknown': 'Wake record expired or unknown',
  'wake.wake_broker_state_indeterminate': 'Wake refused: broker state unconfirmed',
  'wake.unknown': 'Wake status unknown',
  'wake.ambiguous-broker': 'Wake unavailable: ambiguous broker'
} as const

export type HostCardLabelId = keyof typeof HOST_CARD_LABELS
export type HostCardTone = 'normal' | 'muted' | 'warning'

export type HostCardAvailabilityProjection = {
  availabilityText: string
  capabilityText: string
  accessibilityText: string
  tone: HostCardTone
  labelIds: HostCardLabelId[]
}

const SEPARATOR = ' · '

function isLabelId(id: string): id is HostCardLabelId {
  return Object.hasOwn(HOST_CARD_LABELS, id)
}

export function powerLabelId(value: HostPowerState): HostCardLabelId {
  const id = `power.${value}`
  return isLabelId(id) ? id : 'power.unknown'
}

export function orcaLabelId(value: HostOrcaState): HostCardLabelId {
  const id = `orca.${value}`
  return isLabelId(id) ? id : 'orca.unknown'
}

function capabilityValueLabelId(value: HostCapabilityValue): HostCardLabelId {
  const id = `capability-value.${value}`
  return isLabelId(id) ? id : 'capability-value.unknown'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

// Same fields and compat rule as host-status-gates.ts; an unreadable answer is no observation.
function readStatusObservation(snapshot: HomeHostStatusSnapshot): HostStatusObservation | null {
  const result = snapshot.result
  if (!isRecord(result)) {
    return null
  }
  const compat = evaluateCompat({
    desktopProtocolVersion: optionalNumber(result.protocolVersion),
    desktopMinCompatibleMobileVersion: optionalNumber(result.minCompatibleMobileVersion)
  })
  return {
    observedAt: snapshot.observedAt,
    protocolCompatible: compat.kind !== 'blocked',
    graphStatus: optionalString(result.graphStatus),
    desktopWindowStatus: optionalString(result.desktopWindowStatus),
    processKind: parseHostAvailabilityAnnouncement(result).processKind
  }
}

function capabilityLabelIds(capabilities: HostCapabilitySet): HostCardLabelId[][] {
  if (HOST_CAPABILITY_IDS.every((id) => capabilities[id].value === 'unknown')) {
    return [['capabilities.unknown']]
  }
  return HOST_CAPABILITY_IDS.map((id) => [
    `capability.${id}` as const,
    capabilityValueLabelId(capabilities[id].value)
  ])
}

export function presentHostCardAvailability(input: {
  connected: boolean
  verdictKind: ConnectionVerdict['kind']
  lastConnectedAt: number | null
  snapshot: HomeHostStatusSnapshot | undefined
  nowMs: number
}): HostCardAvailabilityProjection {
  const { connected, snapshot, lastConnectedAt } = input
  // Why: an answer from before the latest connect proves nothing about the host now.
  const current =
    connected &&
    snapshot !== undefined &&
    (lastConnectedAt === null || snapshot.observedAt >= lastConnectedAt)
  const availability = composeHostAvailability({
    transport: { verdictKind: input.verdictKind, connected, observedAt: input.nowMs },
    status: current && snapshot ? readStatusObservation(snapshot) : null
  })
  // Why: a capability is announced configuration, so it outlives the connection in this session.
  const capabilities = snapshot
    ? parseHostAvailabilityAnnouncement(snapshot.result).capabilities
    : unknownHostCapabilities('no_status_this_session')

  const powerId = powerLabelId(availability.power.value)
  const orcaId = orcaLabelId(availability.orca.value)
  const capabilityIds = capabilityLabelIds(capabilities)
  const availabilityText = `${HOST_CARD_LABELS[powerId]}${SEPARATOR}${HOST_CARD_LABELS[orcaId]}`
  const capabilityText = capabilityIds
    .map((pair) =>
      pair.length === 2
        ? `${HOST_CARD_LABELS[pair[0]]}: ${HOST_CARD_LABELS[pair[1]]}`
        : HOST_CARD_LABELS[pair[0]]
    )
    .join(SEPARATOR)
  const tone: HostCardTone =
    orcaId === 'orca.version-mismatch' || orcaId === 'orca.unavailable'
      ? 'warning'
      : powerId === 'power.unknown'
        ? 'muted'
        : 'normal'
  const labelIds = [...new Set<HostCardLabelId>([powerId, orcaId, ...capabilityIds.flat()])]
  const spoken = [availabilityText, capabilityText].join(SEPARATOR).split(SEPARATOR)
  return {
    availabilityText,
    capabilityText,
    accessibilityText: spoken.join(', '),
    tone,
    labelIds
  }
}

// All times are the phone's clock; brokerStages is the broker's answer as received.
export type HostCardWakeAttempt = {
  brokerHostId: string
  targetId: string
  requestId: string
  pressedAt: number
  repliedAt: number | null
  wakeId: string | null
  brokerStages: unknown
  refusalCode: string | null
  // Why apart from refusalCode: a later status read failing says nothing about the press (WR-01).
  statusReadCode?: string
}

export type HostCardWakeInputs = {
  hostKey: string | null
  brokers: readonly WakeRouteBroker[]
  attempt: HostCardWakeAttempt | null
}

export type HostCardWakeProjection = {
  showControl: boolean
  busy: boolean
  stageLabelId: HostCardLabelId | null
  stageText: string | null
  tone: HostCardTone
}

const WAKE_STAGE_LABEL: Record<HostWakeStageRecord['stage'], HostCardLabelId> = {
  requested: 'wake.requested',
  authorized: 'wake.authorized',
  'packet-sent': 'wake.packet-sent',
  'packet-send-failed': 'wake.packet-send-failed',
  'host-announced': 'wake.host-announced',
  'runtime-ready': 'wake.runtime-ready'
}

// Why not host_key_unavailable: it is the Owner CLI's passthrough, never a phone wake refusal.
type PhoneWakeRefusalCode = Exclude<HostWakeRefusalCode, 'host_key_unavailable'>

// Why a closed map: a code the shared table gains fails tsc here until it has its own label.
const WAKE_REFUSAL_LABEL: Record<PhoneWakeRefusalCode, HostCardLabelId> = {
  wake_broker_disabled: 'wake.wake_broker_disabled',
  wake_broker_unavailable: 'wake.wake_broker_unavailable',
  wake_device_required: 'wake.wake_device_required',
  wake_device_revoked: 'wake.wake_device_revoked',
  wake_device_unauthorized: 'wake.wake_device_unauthorized',
  wake_device_unknown: 'wake.wake_device_unknown',
  wake_grant_missing: 'wake.wake_grant_missing',
  wake_target_unknown: 'wake.wake_target_unknown',
  wake_target_rebound: 'wake.wake_target_rebound',
  wake_send_failed: 'wake.wake_send_failed',
  wake_unknown: 'wake.wake_unknown',
  wake_broker_state_indeterminate: 'wake.wake_broker_state_indeterminate'
}

const WAKE_WARNING_LABELS: ReadonlySet<HostCardLabelId> = new Set<HostCardLabelId>([
  'wake.packet-send-failed',
  'wake.ambiguous-broker',
  ...Object.values(WAKE_REFUSAL_LABEL)
])

function isPhoneWakeRefusalCode(code: string): code is PhoneWakeRefusalCode {
  return Object.hasOwn(WAKE_REFUSAL_LABEL, code)
}

function refusalLabelId(code: string): HostCardLabelId {
  return isPhoneWakeRefusalCode(code) ? WAKE_REFUSAL_LABEL[code] : 'wake.unknown'
}

function wakeTone(id: HostCardLabelId | null): HostCardTone {
  if (id === 'wake.host-announced' || id === 'wake.runtime-ready') {
    return 'normal'
  }
  return id !== null && WAKE_WARNING_LABELS.has(id) ? 'warning' : 'muted'
}

function attemptStageLabelId(
  attempt: HostCardWakeAttempt,
  snapshot: HomeHostStatusSnapshot | undefined,
  lastConnectedAt: number | null
): HostCardLabelId | null {
  if (attempt.repliedAt === null) {
    return null
  }
  if (attempt.refusalCode !== null) {
    return refusalLabelId(attempt.refusalCode)
  }
  const stage = wakeAttemptFurthestStage(attempt, snapshot, lastConnectedAt)
  return stage === null || statusReadHidesStage(stage, attempt.statusReadCode)
    ? 'wake.unknown'
    : WAKE_STAGE_LABEL[stage]
}

// Why: the shared route decides whether a control exists; a packet sent is never a host woken (D-05, D-06).
export function presentHostCardWake(input: {
  targetHostId: string
  wake: HostCardWakeInputs | undefined
  powerAwake: boolean
  targetSnapshot: HomeHostStatusSnapshot | undefined
  targetLastConnectedAt: number | null
}): HostCardWakeProjection {
  const { wake } = input
  if (wake === undefined) {
    return { showControl: false, busy: false, stageLabelId: null, stageText: null, tone: 'muted' }
  }
  const route = composeHostWakeRoute({
    targetHostId: input.targetHostId,
    hostKey: wake.hostKey,
    brokers: wake.brokers
  })
  const { attempt } = wake
  const stageLabelId: HostCardLabelId | null =
    attempt !== null
      ? attemptStageLabelId(attempt, input.targetSnapshot, input.targetLastConnectedAt)
      : !route.send && route.reason === 'ambiguous_broker'
        ? 'wake.ambiguous-broker'
        : null
  return {
    showControl: route.send && !input.powerAwake,
    busy: attempt !== null && attempt.repliedAt === null,
    stageLabelId,
    stageText: stageLabelId === null ? null : HOST_CARD_LABELS[stageLabelId],
    tone: wakeTone(stageLabelId)
  }
}
