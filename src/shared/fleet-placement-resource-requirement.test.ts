import { describe, expect, it } from 'vitest'
import { toRuntimeExecutionHostId, type ExecutionHostId } from './execution-host'
import type { FleetHostIdentity } from './fleet-host-identity'
import type { FleetHostFacts, FleetResourceSample } from './fleet-resource-observation'
import { planFleetPlacement, type FleetPlacementMember } from './fleet-placement'

const GB = 1024 ** 3
const NOW = 1_000_000

function measuredSample(available: number, startedAt = NOW - 1_000): FleetResourceSample {
  return {
    outcome: 'measured',
    runtimeId: 'rt',
    startedAt,
    totalMemory: 64 * GB,
    availableMemory: available,
    availableMemorySource: 'free-memory',
    processSweep: 'measured'
  }
}

function member(
  address: ExecutionHostId,
  fingerprint: string,
  sample: FleetResourceSample,
  extra: Partial<Pick<FleetPlacementMember, 'nodeResources'>> = {}
): FleetPlacementMember {
  const identity: FleetHostIdentity = { state: 'keyed', fingerprint }
  const facts: FleetHostFacts = {
    runtimeId: `rt-${address}`,
    platform: 'linux',
    capabilities: ['cap.a'],
    protocol: 'compatible'
  }
  return { address, label: address, identity, sample, facts, ...extra }
}

const big = toRuntimeExecutionHostId('big')
const mid = toRuntimeExecutionHostId('mid')
const small = toRuntimeExecutionHostId('small')
const request = { now: NOW, maxSampleAgeMs: 60_000 }

const fleet = () => [
  member(big, 'fp-big', measuredSample(24 * GB)),
  member(mid, 'fp-mid', measuredSample(6 * GB)),
  member(small, 'fp-small', measuredSample(2 * GB))
]

describe('memory requirement reaches the single judge', () => {
  it('rejects the 6 GiB and 2 GiB hosts for an 8 GiB need and selects the 24 GiB host', () => {
    const plan = planFleetPlacement(fleet(), {
      ...request,
      requirement: { memory: { minAvailableBytes: 8 * GB } }
    })

    expect(plan.selected?.fingerprint).toBe('fp-big')
    expect(plan.eligible.map((c) => c.fingerprint)).toEqual(['fp-big'])
    const reasons = Object.fromEntries(plan.rejected.map((r) => [r.fingerprint, r.reasons]))
    expect(reasons['fp-mid']).toEqual([
      { reason: 'insufficient-memory', availableMemory: 6 * GB, required: 8 * GB }
    ])
    expect(reasons['fp-small']).toEqual([
      { reason: 'insufficient-memory', availableMemory: 2 * GB, required: 8 * GB }
    ])
  })

  it('control: a 1 GiB need leaves all three eligible, ranked by free memory', () => {
    const plan = planFleetPlacement(fleet(), {
      ...request,
      requirement: { memory: { minAvailableBytes: 1 * GB } }
    })

    expect(plan.eligible.map((c) => c.fingerprint)).toEqual(['fp-big', 'fp-mid', 'fp-small'])
    expect(plan.rejected).toEqual([])
  })

  it('keeps an unmeasured host at exactly one sample-unmeasured reason', () => {
    const down: FleetResourceSample = {
      outcome: 'unreachable',
      runtimeId: null,
      startedAt: NOW,
      detail: 'down'
    }
    const plan = planFleetPlacement([member(big, 'fp-big', down)], {
      ...request,
      requirement: { memory: { minAvailableBytes: 8 * GB } }
    })

    expect(plan.rejected[0]?.reasons).toEqual([
      { reason: 'sample-unmeasured', outcome: 'unreachable' }
    ])
  })

  it('keeps a stale host at exactly one sample-stale reason, never compared', () => {
    const plan = planFleetPlacement(
      [member(small, 'fp-small', measuredSample(2 * GB, NOW - 120_000))],
      { ...request, requirement: { memory: { minAvailableBytes: 8 * GB } } }
    )

    expect(plan.rejected[0]?.reasons).toEqual([{ reason: 'sample-stale', ageMs: 120_000 }])
  })

  it('still honours the legacy minAvailableBytes field with the same shape', () => {
    const plan = planFleetPlacement(fleet(), { ...request, minAvailableBytes: 8 * GB })

    expect(plan.eligible.map((c) => c.fingerprint)).toEqual(['fp-big'])
    expect(plan.rejected.find((r) => r.fingerprint === 'fp-small')?.reasons).toEqual([
      { reason: 'insufficient-memory', availableMemory: 2 * GB, required: 8 * GB }
    ])
  })

  it('applies the larger bound when requirement.memory and minAvailableBytes are both set', () => {
    const plan = planFleetPlacement(fleet(), {
      ...request,
      minAvailableBytes: 1 * GB,
      requirement: { memory: { minAvailableBytes: 8 * GB } }
    })
    expect(plan.eligible.map((c) => c.fingerprint)).toEqual(['fp-big'])

    const swapped = planFleetPlacement(fleet(), {
      ...request,
      minAvailableBytes: 8 * GB,
      requirement: { memory: { minAvailableBytes: 1 * GB } }
    })
    expect(swapped.eligible.map((c) => c.fingerprint)).toEqual(['fp-big'])
    expect(swapped.rejected.find((r) => r.fingerprint === 'fp-mid')?.reasons).toEqual([
      { reason: 'insufficient-memory', availableMemory: 6 * GB, required: 8 * GB }
    ])
  })

  it('treats a requirement with no family set as no requirement', () => {
    const plan = planFleetPlacement(fleet(), { ...request, requirement: {} })

    expect(plan.eligible).toHaveLength(3)
    expect(plan.rejected).toEqual([])
  })

  it('judges a request with no requirement exactly as before', () => {
    expect(planFleetPlacement(fleet(), request)).toEqual(
      planFleetPlacement(fleet(), { ...request, requirement: {} })
    )
  })
})
