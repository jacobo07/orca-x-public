import { describe, expect, it } from 'vitest'
import type { MobileRelayStatus } from '../../shared/mobile-relay-status'
import type { HostRelayReadiness } from './relay/host-relay-startup'
import {
  createHostAvailabilityProducer,
  describeDirectCapability,
  describeRelayCapability,
  describeRemoteWakeCapability
} from './host-availability-producer'
import { createHostOobProbe } from './host-oob-probe'
import { WINDOWS_OOB_PROBE_SCRIPT } from './host-oob-verdict'
import { createHostWolProbe } from './host-wol-probe'

const T = 1_760_000_000_000
const NIC_DESCRIPTION = 'Intel(R) Ethernet Connection I219-LM'
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
      autostart: { read: () => ({ value: 'unknown', reason: 'first', evidence: null }) },
      wakeOnLan: { read: () => ({ value: 'unknown', reason: 'first', evidence: null }) },
      oob: { read: () => ({ value: 'unknown', reason: 'first', evidence: null }) }
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
      },
      wakeOnLan: {
        read: () => ({ value: 'unknown', reason: 'wol_probe_pending', evidence: null })
      },
      oob: { read: () => ({ value: 'unknown', reason: 'oob_probe_pending', evidence: null }) }
    })
    const announcement = producer.describe()
    expect(announcement.processKind).toBe('desktop')
    expect(announcement.capabilities['can-relay'].reason).toBe('relay_standby')
    expect(announcement.capabilities['can-start-orca'].reason).toBe('logon_task_absent')
    expect(announcement.capabilities['can-wake-lan'].reason).toBe('wol_probe_pending')
    const serialized = JSON.stringify(announcement)
    expect(serialized).not.toContain('192.168.7.11')
    expect(serialized).not.toContain('10.9.8.7')
    expect(serialized).not.toContain('ws://')
  })

  it('announces the WOL reader verdict and never serializes adapter identity', async () => {
    const probe = createHostWolProbe({
      platform: 'win32',
      now: () => T,
      exec: (file) =>
        Promise.resolve({
          code: 0,
          stdout:
            file === 'powershell.exe'
              ? `[{"Name":"Ethernet 7","InterfaceDescription":"${NIC_DESCRIPTION}","MediaType":"802.3","WakeOnMagicPacket":"Enabled"}]`
              : `${NIC_DESCRIPTION}\r\n`,
          stderr: ''
        }),
      listPhysicalInterfaces: () => Promise.resolve([]),
      readText: () => Promise.resolve(null)
    })
    probe.read()
    await probe.settled()
    const producer = createHostAvailabilityProducer({ now: () => T })
    producer.register({
      processKind: 'serve',
      relayReadiness: () => ({ state: 'started', status: null }),
      webSocketEndpoint: () => null,
      autostart: { read: () => ({ value: 'unknown', reason: 'first', evidence: null }) },
      wakeOnLan: probe,
      oob: { read: () => ({ value: 'unknown', reason: 'first', evidence: null }) }
    })
    const announcement = producer.describe()
    expect(announcement.capabilities['can-wake-lan']).toEqual(probe.read())
    expect(announcement.capabilities['can-wake-lan']).toEqual({
      value: 'unknown',
      reason: 'firmware_unverified',
      evidence: null
    })
    const serialized = JSON.stringify(announcement)
    expect(serialized).not.toContain('Ethernet 7')
    expect(serialized).not.toContain(NIC_DESCRIPTION)
  })
})

const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'

function amdOobProbe() {
  const calls: { file: string; args: readonly string[] }[] = []
  let clock = T
  const probe = createHostOobProbe({
    platform: 'win32',
    now: () => clock,
    exec: (file, args) => {
      calls.push({ file, args })
      return Promise.resolve({ code: 0, stdout: 'vendor=AuthenticAMD\r\nmei=0\r\n' })
    },
    readText: () => Promise.resolve(null),
    exists: () => Promise.resolve(false),
    windowsPowerShellPath: POWERSHELL
  })
  return {
    probe,
    calls,
    advance: (ms: number) => {
      clock += ms
    }
  }
}

function registerWithOob(
  producer: ReturnType<typeof createHostAvailabilityProducer>,
  oob: { read: () => ReturnType<ReturnType<typeof createHostOobProbe>['read']> },
  relayReadiness: HostRelayReadiness = { state: 'started', status: null }
): void {
  producer.register({
    processKind: 'desktop',
    relayReadiness: () => relayReadiness,
    webSocketEndpoint: () => null,
    autostart: { read: () => ({ value: 'unknown', reason: 'first', evidence: null }) },
    wakeOnLan: { read: () => ({ value: 'unknown', reason: 'first', evidence: null }) },
    oob
  })
}

describe('can-power-on-oob from the OOB probe (D-07)', () => {
  it('answers pending first, then unknown amd_no_amt_oob_unmeasured on an AMD CPU', async () => {
    const h = amdOobProbe()
    expect(h.probe.read()).toEqual({
      value: 'unknown',
      reason: 'oob_probe_pending',
      evidence: null
    })
    expect(h.calls).toHaveLength(1)
    h.advance(400)
    await h.probe.settled()
    expect(h.probe.read()).toEqual({
      value: 'unknown',
      reason: 'amd_no_amt_oob_unmeasured',
      evidence: null
    })
  })

  it('spawns the absolute PowerShell path with the constant script as argv only', async () => {
    const h = amdOobProbe()
    h.probe.read()
    await h.probe.settled()
    expect(h.calls).toEqual([
      {
        file: POWERSHELL,
        args: ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_OOB_PROBE_SCRIPT]
      }
    ])
  })

  it('announces the probe answer and never serializes CPU or board names', async () => {
    const h = amdOobProbe()
    h.probe.read()
    await h.probe.settled()
    const producer = createHostAvailabilityProducer({ now: () => T })
    registerWithOob(producer, h.probe)
    const announcement = producer.describe()
    expect(announcement.capabilities['can-power-on-oob']).toEqual(h.probe.read())
    expect(announcement.capabilities['can-power-on-oob'].reason).toBe('amd_no_amt_oob_unmeasured')
    const serialized = JSON.stringify(announcement)
    expect(serialized).not.toContain('AuthenticAMD')
    expect(serialized).not.toContain('MS-7B89')
  })

  it('reads unknown oob_reader_unregistered before anything registers', () => {
    expect(
      createHostAvailabilityProducer({ now: () => T }).describe().capabilities['can-power-on-oob']
    ).toEqual({ value: 'unknown', reason: 'oob_reader_unregistered', evidence: null })
  })
})

describe('can-wake-remote is pinned behind one producer (D-04 option B)', () => {
  const NOT_CONFIGURED = {
    value: 'not-configured',
    reason: 'no_wake_broker',
    evidence: { kind: 'host-announced', observedAt: T }
  }
  const READINESS_ROWS: [string, HostRelayReadiness | null][] = [
    ['relay readiness null', null],
    [
      'relay unavailable cloud_auth_not_configured',
      { state: 'unavailable', reason: 'cloud_auth_not_configured' }
    ],
    ['relay started with status null', { state: 'started', status: null }],
    ['relay started with a status', { state: 'started', status: 'registered' }]
  ]

  it('describeRemoteWakeCapability answers not-configured no_wake_broker host-announced', () => {
    expect(describeRemoteWakeCapability(T)).toEqual(NOT_CONFIGURED)
  })

  it.each(READINESS_ROWS)('%s announces not-configured no_wake_broker', (_name, readiness) => {
    const producer = createHostAvailabilityProducer({ now: () => T })
    if (readiness !== null) {
      registerWithOob(producer, amdOobProbe().probe, readiness)
    }
    const remote = producer.describe().capabilities['can-wake-remote']
    expect(remote).toEqual(NOT_CONFIGURED)
    expect(remote).toEqual(describeRemoteWakeCapability(T))
  })
})
