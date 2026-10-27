import { describe, expect, it } from 'vitest'
import type { MobileRelayStatus } from '../../shared/mobile-relay-status'
import {
  createHostAvailabilityProducer,
  describeDirectCapability,
  describeRelayCapability
} from './host-availability-producer'

const T = 1_760_000_000_000
const RELAY_STATUSES: MobileRelayStatus[] = [
  'connecting',
  'registered',
  'standby',
  'draining',
  'offline'
]

describe('describeRelayCapability', () => {
  it('maps missing cloud auth to needs-owner-setup', () => {
    expect(
      describeRelayCapability({ state: 'unavailable', reason: 'cloud_auth_not_configured' }, T)
    ).toEqual({
      value: 'needs-owner-setup',
      reason: 'cloud_auth_not_configured',
      evidence: { kind: 'host-announced', observedAt: T }
    })
  })

  it.each(['mobile_runtime_not_ready', 'relay_startup_failed'] as const)(
    'maps unavailable %s to unknown with that reason',
    (reason) => {
      expect(describeRelayCapability({ state: 'unavailable', reason }, T)).toEqual({
        value: 'unknown',
        reason,
        evidence: null
      })
    }
  )

  it('maps a started relay with no broker emission yet to unknown relay_status_pending', () => {
    expect(describeRelayCapability({ state: 'started', status: null }, T)).toEqual({
      value: 'unknown',
      reason: 'relay_status_pending',
      evidence: null
    })
  })

  it.each(RELAY_STATUSES)('maps a started relay reporting %s to supported', (status) => {
    expect(describeRelayCapability({ state: 'started', status }, T)).toEqual({
      value: 'supported',
      reason: `relay_${status}`,
      evidence: { kind: 'relay-reported', observedAt: T }
    })
  })

  it('maps an unregistered readiness to unknown', () => {
    expect(describeRelayCapability(null, T)).toEqual({
      value: 'unknown',
      reason: 'relay_readiness_unregistered',
      evidence: null
    })
  })
})

describe('describeDirectCapability', () => {
  it('maps a null endpoint to not-configured websocket_listener_absent', () => {
    expect(describeDirectCapability(null, true, T)).toEqual({
      value: 'not-configured',
      reason: 'websocket_listener_absent',
      evidence: { kind: 'host-announced', observedAt: T }
    })
  })

  it.each(['ws://127.0.0.1:6768', 'ws://127.4.5.6:6768', 'ws://localhost:6768', 'ws://[::1]:6768'])(
    'maps loopback %s to not-configured bound_to_loopback',
    (endpoint) => {
      expect(describeDirectCapability(endpoint, true, T)).toEqual({
        value: 'not-configured',
        reason: 'bound_to_loopback',
        evidence: { kind: 'host-announced', observedAt: T }
      })
    }
  )

  it.each(['ws://0.0.0.0:6768', 'ws://192.168.7.11:6768'])('maps %s to supported', (endpoint) => {
    expect(describeDirectCapability(endpoint, true, T)).toEqual({
      value: 'supported',
      reason: 'websocket_listener_bound',
      evidence: { kind: 'host-announced', observedAt: T }
    })
  })

  it('maps an unparseable endpoint to unknown', () => {
    expect(describeDirectCapability('not a url', true, T)).toEqual({
      value: 'unknown',
      reason: 'websocket_endpoint_unparseable',
      evidence: null
    })
  })

  it('maps an unregistered listener to unknown', () => {
    expect(describeDirectCapability(null, false, T)).toEqual({
      value: 'unknown',
      reason: 'listener_unregistered',
      evidence: null
    })
  })
})

describe('createHostAvailabilityProducer', () => {
  it('reports unknown sources and no process kind before anything registers', () => {
    const announcement = createHostAvailabilityProducer({ now: () => T }).describe()
    expect(announcement).toMatchObject({ schema: 1, processKind: null, observedAt: T })
    expect(announcement.capabilities['can-relay']).toEqual({
      value: 'unknown',
      reason: 'relay_readiness_unregistered',
      evidence: null
    })
    expect(announcement.capabilities['can-direct']).toEqual({
      value: 'unknown',
      reason: 'listener_unregistered',
      evidence: null
    })
    expect(announcement.capabilities['can-start-orca']).toEqual({
      value: 'unknown',
      reason: 'autostart_reader_unregistered',
      evidence: null
    })
  })

  it('replaces an earlier registration and never serializes the endpoint', () => {
    const producer = createHostAvailabilityProducer({ now: () => T })
    producer.register({
      processKind: 'serve',
      relayReadiness: () => ({ state: 'started', status: null }),
      webSocketEndpoint: () => 'ws://10.9.8.7:6768',
      autostart: { read: () => ({ value: 'unknown', reason: 'first', evidence: null }) }
    })
    producer.register({
      processKind: 'desktop',
      relayReadiness: () => ({ state: 'started', status: 'standby' }),
      webSocketEndpoint: () => 'ws://192.168.7.11:6768',
      autostart: {
        read: () => ({
          value: 'not-configured',
          reason: 'logon_task_absent',
          evidence: { kind: 'os-probe', observedAt: T }
        })
      }
    })
    const announcement = producer.describe()
    expect(announcement.processKind).toBe('desktop')
    expect(announcement.capabilities['can-relay'].reason).toBe('relay_standby')
    expect(announcement.capabilities['can-start-orca'].reason).toBe('logon_task_absent')
    const serialized = JSON.stringify(announcement)
    expect(serialized).not.toContain('192.168.7.11')
    expect(serialized).not.toContain('10.9.8.7')
    expect(serialized).not.toContain('ws://')
  })
})
