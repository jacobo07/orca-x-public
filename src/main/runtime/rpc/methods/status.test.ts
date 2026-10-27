import { afterEach, describe, expect, it } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { isStreamingMethod } from '../core'
import { RUNTIME_CAPABILITIES } from '../../../../shared/protocol-version'
import {
  HOST_CAPABILITY_IDS,
  composeHostAvailability,
  parseHostAvailabilityAnnouncement
} from '../../../../shared/host-availability'
import {
  createHostAvailabilityProducer,
  hostAvailabilityProducer
} from '../../host-availability-producer'
import { STATUS_METHODS } from './status'

const T = 1_760_000_000_000

function fakeRuntime(): OrcaRuntimeService {
  return {
    getRuntimeId: () => 'runtime-1',
    getStatus: () => ({
      runtimeId: 'runtime-1',
      graphStatus: 'ready',
      desktopWindowStatus: 'openable',
      capabilities: [...RUNTIME_CAPABILITIES]
    })
  } as unknown as OrcaRuntimeService
}

async function callStatusGet(): Promise<Record<string, unknown>> {
  const method = STATUS_METHODS[0]
  if (isStreamingMethod(method)) {
    throw new Error('status.get must be a request method')
  }
  return (await method.handler(null, { runtime: fakeRuntime() })) as Record<string, unknown>
}

function registerServeHost(): void {
  hostAvailabilityProducer.register({
    processKind: 'serve',
    relayReadiness: () => ({ state: 'started', status: 'registered' }),
    webSocketEndpoint: () => 'ws://0.0.0.0:6768',
    autostart: {
      read: () => ({
        value: 'supported',
        reason: 'logon_task_installed',
        evidence: { kind: 'os-probe', observedAt: T }
      })
    }
  })
}

describe('status.get host availability', () => {
  afterEach(() => {
    // Why: the module producer is process-wide; reset it so tests do not leak sources.
    hostAvailabilityProducer.register({
      processKind: 'serve',
      relayReadiness: () => ({ state: 'unavailable', reason: 'relay_startup_failed' }),
      webSocketEndpoint: () => null,
      autostart: { read: () => ({ value: 'unknown', reason: 'test_reset', evidence: null }) }
    })
  })

  it('announces host.availability.v1 in RUNTIME_CAPABILITIES', () => {
    expect(RUNTIME_CAPABILITIES).toContain('host.availability.v1')
  })

  it('carries a schema 1 announcement with exactly the six capability ids', async () => {
    registerServeHost()
    const result = await callStatusGet()
    const announcement = result.hostAvailability as Record<string, unknown>
    expect(announcement.schema).toBe(1)
    expect(announcement.processKind).toBe('serve')
    expect(Object.keys(announcement.capabilities as object).sort()).toEqual(
      [...HOST_CAPABILITY_IDS].sort()
    )
    expect(result.runtimeId).toBe('runtime-1')
    expect(result.appVersion).toEqual(expect.any(String))
    expect(result.remoteUpdateSupport).toBeDefined()
  })

  it('round-trips host producer -> wire -> phone parser with the registered sources', async () => {
    registerServeHost()
    const wire = JSON.parse(JSON.stringify(await callStatusGet()))
    const parsed = parseHostAvailabilityAnnouncement(wire)
    expect(parsed.processKind).toBe('serve')
    const caps = parsed.capabilities
    expect(caps['can-relay']).toMatchObject({
      value: 'supported',
      reason: 'relay_registered',
      evidence: { kind: 'relay-reported' }
    })
    expect(caps['can-direct'].value).toBe('supported')
    expect(caps['can-wake-lan']).toMatchObject({
      value: 'not-configured',
      reason: 'no_wake_broker'
    })
    expect(caps['can-wake-remote']).toMatchObject({
      value: 'not-configured',
      reason: 'no_wake_broker'
    })
    expect(caps['can-power-on-oob']).toEqual({
      value: 'unknown',
      reason: 'oob_not_measured',
      evidence: null
    })
    expect(caps['can-start-orca']).toEqual({
      value: 'supported',
      reason: 'logon_task_installed',
      evidence: { kind: 'os-probe', observedAt: T }
    })
  })

  it('composes a live serve answer into awake + service-ready with live-response evidence', async () => {
    registerServeHost()
    const wire = JSON.parse(JSON.stringify(await callStatusGet()))
    const parsed = parseHostAvailabilityAnnouncement(wire)
    const availability = composeHostAvailability({
      transport: { verdictKind: 'normal', connected: true, observedAt: T },
      status: {
        observedAt: T,
        protocolCompatible: true,
        graphStatus: wire.graphStatus,
        desktopWindowStatus: wire.desktopWindowStatus,
        processKind: parsed.processKind
      }
    })
    expect(availability.power).toEqual({
      value: 'awake',
      evidence: { kind: 'live-response', observedAt: T }
    })
    expect(availability.orca).toMatchObject({ value: 'service-ready', detail: 'openable' })
    expect(availability.connectivity).toEqual({
      value: 'normal',
      evidence: { kind: 'transport-observed', observedAt: T }
    })
  })

  it('composes no response into unknown power and orca, never powered-off', () => {
    const availability = composeHostAvailability({
      transport: { verdictKind: 'unreachable', connected: false, observedAt: T },
      status: null
    })
    expect(availability.power).toEqual({
      value: 'unknown',
      evidence: null,
      reason: 'not_connected'
    })
    expect(availability.orca).toEqual({ value: 'unknown', evidence: null, reason: 'not_connected' })
    expect(availability.power.value).not.toBe('powered-off')
  })

  it('parses an old host answer to six host_did_not_announce unknowns', async () => {
    registerServeHost()
    const wire = JSON.parse(JSON.stringify(await callStatusGet()))
    delete wire.hostAvailability
    wire.capabilities = (wire.capabilities as string[]).filter(
      (capability) => capability !== 'host.availability.v1'
    )
    const parsed = parseHostAvailabilityAnnouncement(wire)
    expect(parsed.processKind).toBeNull()
    for (const id of HOST_CAPABILITY_IDS) {
      expect(parsed.capabilities[id]).toEqual({
        value: 'unknown',
        reason: 'host_did_not_announce',
        evidence: null
      })
    }
  })

  it('reports unregistered sources as unknown on a fresh producer', () => {
    const announcement = createHostAvailabilityProducer({ now: () => T }).describe()
    expect(announcement.processKind).toBeNull()
    expect(announcement.capabilities['can-start-orca'].value).toBe('unknown')
  })
})
