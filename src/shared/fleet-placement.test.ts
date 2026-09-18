import { describe, expect, it } from 'vitest'
import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from './execution-host'
import type { FleetHostIdentity } from './fleet-host-identity'
import type { FleetHostFacts, FleetResourceSample } from './fleet-resource-observation'
import { planFleetPlacement, type FleetPlacementMember } from './fleet-placement'

const GB = 1024 ** 3
const NOW = 1_000_000

function member(
  address: ExecutionHostId,
  fingerprint: string | null,
  available: number | null,
  overrides: {
    facts?: Partial<FleetHostFacts>
    sample?: FleetResourceSample
    identity?: FleetHostIdentity
  } = {}
): FleetPlacementMember {
  const identity: FleetHostIdentity =
    overrides.identity ??
    (fingerprint ? { state: 'keyed', fingerprint } : { state: 'unavailable', reason: 'no-key' })
  const sample: FleetResourceSample =
    overrides.sample ??
    (available === null
      ? { outcome: 'unreachable', runtimeId: null, startedAt: NOW, detail: 'down' }
      : {
          outcome: 'measured',
          runtimeId: `rt-${address}`,
          startedAt: NOW - 1_000,
          totalMemory: 32 * GB,
          availableMemory: available,
          availableMemorySource: 'free-memory',
          processSweep: 'measured'
        })
  return {
    address,
    label: address,
    identity,
    sample,
    facts: {
      runtimeId: `rt-${address}`,
      platform: 'linux',
      capabilities: ['cap.a', 'cap.b'],
      protocol: 'compatible',
      ...overrides.facts
    }
  }
}

const vps = toRuntimeExecutionHostId('vps')
const box = toRuntimeExecutionHostId('box')
const self = toRuntimeExecutionHostId('self')
const request = { now: NOW, maxSampleAgeMs: 60_000 }

describe('fleet placement planning', () => {
  it('selects the eligible host with the most measured headroom and explains the rest', () => {
    const plan = planFleetPlacement(
      [
        member(LOCAL_EXECUTION_HOST_ID, 'fp-local', 2 * GB),
        member(vps, 'fp-vps', 9 * GB),
        member(box, 'fp-box', null)
      ],
      { ...request, minAvailableBytes: 1 * GB }
    )
    expect(plan.selected?.fingerprint).toBe('fp-vps')
    expect(plan.eligible.map((c) => c.fingerprint)).toEqual(['fp-vps', 'fp-local'])
    expect(plan.rejected).toEqual([
      {
        key: 'fingerprint:fp-box',
        fingerprint: 'fp-box',
        addresses: [box],
        reasons: [{ reason: 'sample-unmeasured', outcome: 'unreachable' }]
      }
    ])
  })

  it('never lets an unknown satisfy a hard constraint', () => {
    const plan = planFleetPlacement(
      [
        member(vps, 'fp-vps', 9 * GB, {
          facts: { platform: null, capabilities: null, protocol: 'unknown' }
        }),
        member(box, null, 9 * GB)
      ],
      { ...request, platform: 'linux', requiredCapabilities: ['cap.a'] }
    )
    expect(plan.selected).toBeNull()
    expect(plan.decision).toBe('no-eligible-host')
    const reasons = Object.fromEntries(
      plan.rejected.map((r) => [r.key, r.reasons.map((x) => x.reason)])
    )
    expect(reasons['fingerprint:fp-vps']).toEqual([
      'protocol-unknown',
      'platform-unknown',
      'capabilities-unknown'
    ])
    expect(reasons[`address:${box}`]).toEqual(['identity-unavailable'])
  })

  it('rejects unreadable identity, blocked protocol, wrong platform, missing capability, stale and short hosts', () => {
    const stale: FleetResourceSample = {
      outcome: 'measured',
      runtimeId: 'r',
      startedAt: NOW - 120_000,
      totalMemory: 32 * GB,
      availableMemory: 9 * GB,
      availableMemorySource: 'free-memory',
      processSweep: 'measured'
    }
    const plan = planFleetPlacement(
      [
        member(toRuntimeExecutionHostId('c'), null, 9 * GB, {
          identity: { state: 'unavailable', reason: 'key-unreadable' }
        }),
        member(toRuntimeExecutionHostId('p'), 'fp-p', 9 * GB, { facts: { protocol: 'blocked' } }),
        member(toRuntimeExecutionHostId('w'), 'fp-w', 9 * GB, { facts: { platform: 'win32' } }),
        member(toRuntimeExecutionHostId('m'), 'fp-m', 9 * GB, {
          facts: { capabilities: ['cap.b'] }
        }),
        member(toRuntimeExecutionHostId('s'), 'fp-s', 9 * GB, { sample: stale }),
        member(toRuntimeExecutionHostId('l'), 'fp-l', 512 * 1024 ** 2)
      ],
      { ...request, platform: 'linux', requiredCapabilities: ['cap.a'], minAvailableBytes: 1 * GB }
    )
    expect(plan.selected).toBeNull()
    const reasons = Object.fromEntries(plan.rejected.map((r) => [r.key, r.reasons]))
    expect(reasons['fingerprint:fp-p']).toEqual([{ reason: 'protocol-blocked' }])
    expect(reasons['fingerprint:fp-w']).toEqual([
      { reason: 'platform-mismatch', platform: 'win32' }
    ])
    expect(reasons['fingerprint:fp-m']).toEqual([
      { reason: 'capability-missing', capabilities: ['cap.a'] }
    ])
    expect(reasons['fingerprint:fp-s']).toEqual([{ reason: 'sample-stale', ageMs: 120_000 }])
    expect(reasons['fingerprint:fp-l']).toEqual([
      { reason: 'insufficient-memory', availableMemory: 512 * 1024 ** 2, required: 1 * GB }
    ])
    expect(reasons[`address:${toRuntimeExecutionHostId('c')}`]).toEqual([
      { reason: 'identity-unavailable' }
    ])
  })

  it('plans one candidate per key and prefers the in-process reading even over a fresher copy', () => {
    // Why: the remote copy of this machine is read over its own socket after the local sweep.
    const remoteView: FleetResourceSample = {
      outcome: 'measured',
      runtimeId: 'r',
      startedAt: NOW - 500,
      totalMemory: 32 * GB,
      availableMemory: 1 * GB,
      availableMemorySource: 'free-memory',
      processSweep: 'measured'
    }
    const plan = planFleetPlacement(
      [
        member(self, 'fp-local', null, { sample: remoteView }),
        member(LOCAL_EXECUTION_HOST_ID, 'fp-local', 3 * GB)
      ],
      request
    )
    expect(plan.eligible).toHaveLength(1)
    expect(plan.selected).toMatchObject({
      fingerprint: 'fp-local',
      addresses: [LOCAL_EXECUTION_HOST_ID, self],
      evidenceAddress: LOCAL_EXECUTION_HOST_ID,
      availableMemory: 3 * GB
    })
  })

  it('judges two remote addresses of one host by the fresher measurement', () => {
    const at = (startedAt: number, available: number): FleetResourceSample => ({
      outcome: 'measured',
      runtimeId: 'r',
      startedAt,
      totalMemory: 32 * GB,
      availableMemory: available,
      availableMemorySource: 'proc-meminfo',
      processSweep: 'measured'
    })
    const plan = planFleetPlacement(
      [
        member(toRuntimeExecutionHostId('a-old'), 'fp-x', null, {
          sample: at(NOW - 20_000, 1 * GB)
        }),
        member(toRuntimeExecutionHostId('b-new'), 'fp-x', null, { sample: at(NOW - 2_000, 7 * GB) })
      ],
      request
    )
    expect(plan.selected).toMatchObject({
      evidenceAddress: toRuntimeExecutionHostId('b-new'),
      availableMemory: 7 * GB
    })
  })

  it('prefers the current placement only on equal headroom, then the fingerprint', () => {
    const hosts = [member(vps, 'fp-b', 4 * GB), member(box, 'fp-a', 4 * GB)]
    expect(planFleetPlacement(hosts, request).selected?.fingerprint).toBe('fp-a')
    expect(
      planFleetPlacement(hosts, { ...request, currentFingerprint: 'fp-b' }).selected?.fingerprint
    ).toBe('fp-b')
    expect(
      planFleetPlacement([member(vps, 'fp-b', 4 * GB), member(box, 'fp-a', 5 * GB)], {
        ...request,
        currentFingerprint: 'fp-b'
      }).selected?.fingerprint
    ).toBe('fp-a')
  })

  it('returns an identical plan whatever the input order', () => {
    const hosts = [
      member(LOCAL_EXECUTION_HOST_ID, 'fp-local', 2 * GB),
      member(vps, 'fp-vps', 2 * GB),
      member(box, 'fp-box', null),
      member(self, 'fp-local', 2 * GB)
    ]
    expect(planFleetPlacement(hosts.toReversed(), request)).toEqual(
      planFleetPlacement(hosts, request)
    )
  })
})
