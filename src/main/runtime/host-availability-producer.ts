import type {
  HostAvailabilityAnnouncement,
  HostCapability,
  HostProcessKind
} from '../../shared/host-availability'
import type { HostRelayReadiness } from './relay/host-relay-startup'

export type HostAvailabilitySources = {
  processKind: HostProcessKind
  relayReadiness: () => HostRelayReadiness
  webSocketEndpoint: () => string | null
  autostart: { read: () => HostCapability }
  wakeOnLan: { read: () => HostCapability }
}

function unknownCapability(reason: string): HostCapability {
  return { value: 'unknown', reason, evidence: null }
}

export function describeRelayCapability(
  readiness: HostRelayReadiness | null,
  nowMs: number
): HostCapability {
  if (readiness === null) {
    return unknownCapability('relay_readiness_unregistered')
  }
  if (readiness.state === 'unavailable') {
    // Why: missing cloud auth is a setup step the Owner can take; the other reasons are faults with no known fix.
    return readiness.reason === 'cloud_auth_not_configured'
      ? {
          value: 'needs-owner-setup',
          reason: readiness.reason,
          evidence: { kind: 'host-announced', observedAt: nowMs }
        }
      : unknownCapability(readiness.reason)
  }
  if (readiness.status === null) {
    return unknownCapability('relay_status_pending')
  }
  return {
    value: 'supported',
    reason: `relay_${readiness.status}`,
    evidence: { kind: 'relay-reported', observedAt: nowMs }
  }
}

export function describeDirectCapability(
  endpoint: string | null,
  registered: boolean,
  nowMs: number
): HostCapability {
  if (!registered) {
    return unknownCapability('listener_unregistered')
  }
  if (endpoint === null) {
    return {
      value: 'not-configured',
      reason: 'websocket_listener_absent',
      evidence: { kind: 'host-announced', observedAt: nowMs }
    }
  }
  let hostname: string
  try {
    hostname = new URL(endpoint).hostname
  } catch {
    return unknownCapability('websocket_endpoint_unparseable')
  }
  const evidence = { kind: 'host-announced', observedAt: nowMs } as const
  // Why: a loopback listener is unreachable from any phone, so direct is not configured.
  return isLoopbackHostname(hostname)
    ? { value: 'not-configured', reason: 'bound_to_loopback', evidence }
    : { value: 'supported', reason: 'websocket_listener_bound', evidence }
}

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '::1' ||
    hostname === '[::1]' ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)
  )
}

export function createHostAvailabilityProducer(options: { now?: () => number } = {}): {
  register(sources: HostAvailabilitySources): void
  describe(): HostAvailabilityAnnouncement
} {
  const now = options.now ?? Date.now
  let sources: HostAvailabilitySources | null = null
  return {
    register: (next) => {
      sources = next
    },
    describe: () => {
      const nowMs = now()
      const announced = { kind: 'host-announced', observedAt: nowMs } as const
      return {
        schema: 1,
        processKind: sources?.processKind ?? null,
        observedAt: nowMs,
        capabilities: {
          'can-start-orca':
            sources?.autostart.read() ?? unknownCapability('autostart_reader_unregistered'),
          // Why: can-wake-lan is measured by the WOL probe (D-01); remote wake is still phase 20.
          'can-wake-lan': sources?.wakeOnLan.read() ?? unknownCapability('wol_reader_unregistered'),
          'can-wake-remote': {
            value: 'not-configured',
            reason: 'no_wake_broker',
            evidence: announced
          },
          // Why: nothing in code measures out-of-band power-on, and D-05 says unmeasured is unknown.
          'can-power-on-oob': unknownCapability('oob_not_measured'),
          'can-relay': describeRelayCapability(sources?.relayReadiness() ?? null, nowMs),
          'can-direct': describeDirectCapability(
            sources?.webSocketEndpoint() ?? null,
            sources !== null,
            nowMs
          )
        }
      }
    }
  }
}

// Why module scope: status.get and both host start paths in index.ts must share one producer.
export const hostAvailabilityProducer = createHostAvailabilityProducer()
