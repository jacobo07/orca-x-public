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
import type { ConnectionVerdict } from '../transport/connection-health'
import type { HomeHostStatusSnapshot } from '../transport/home-host-status-fetch'
import { evaluateCompat } from '../transport/protocol-compat'

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
  'capabilities.unknown': 'Capabilities unknown'
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
