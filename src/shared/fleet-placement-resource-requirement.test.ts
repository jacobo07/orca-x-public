import { describe, expect, it } from 'vitest'
import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from './execution-host'
import type { FleetHostIdentity } from './fleet-host-identity'
import type { FleetHostFacts, FleetResourceSample } from './fleet-resource-observation'
import { planFleetPlacement, type FleetPlacementMember } from './fleet-placement'
import type { FleetNodeResourcesObservation } from './node-resources'

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

function resources(
  parts: Partial<Omit<FleetNodeResourcesObservation, 'startedAt'>> = {},
  startedAt = NOW - 1_000
): FleetNodeResourcesObservation {
  return {
    startedAt,
    runtimeId: 'rt',
    disk: { outcome: 'unknown', reason: 'not-attempted' },
    gpu: { outcome: 'unknown', reason: 'no-gpu-tool' },
    models: { outcome: 'unknown', reason: 'no-probe-configured' },
    ...parts
  }
}

const gpu = (freeBytes: number): FleetNodeResourcesObservation['gpu'] => ({
  outcome: 'measured',
  gpus: [{ name: 'gpu0', totalBytes: 24 * GB, freeBytes }]
})
const vramNeed = (minFreeBytes: number) => ({ requirement: { vram: { minFreeBytes } } })
const eligibleOf = (plan: ReturnType<typeof planFleetPlacement>) =>
  plan.eligible.map((c) => c.fingerprint)
const reasonsOf = (plan: ReturnType<typeof planFleetPlacement>, fingerprint: string) =>
  plan.rejected.find((r) => r.fingerprint === fingerprint)?.reasons

describe('VRAM requirement', () => {
  it('rejects measured VRAM below the need with both figures, selects sufficient VRAM', () => {
    const plan = planFleetPlacement(
      [
        member(mid, 'fp-low', measuredSample(8 * GB), {
          nodeResources: resources({ gpu: gpu(4 * GB) })
        }),
        member(big, 'fp-ok', measuredSample(8 * GB), {
          nodeResources: resources({ gpu: gpu(16 * GB) })
        })
      ],
      { ...request, ...vramNeed(8 * GB) }
    )

    expect(plan.selected?.fingerprint).toBe('fp-ok')
    expect(reasonsOf(plan, 'fp-low')).toEqual([
      { reason: 'insufficient-vram', freeBytes: 4 * GB, required: 8 * GB }
    ])
  })

  it('rejects absent nodeResources as resource-unknown for vram and never selects it', () => {
    const plan = planFleetPlacement([member(big, 'fp-none', measuredSample(24 * GB))], {
      ...request,
      ...vramNeed(1)
    })

    expect(plan.decision).toBe('no-eligible-host')
    expect(reasonsOf(plan, 'fp-none')).toEqual([
      { reason: 'resource-unknown', family: 'vram', cause: 'unmeasured', detail: 'not-attempted' }
    ])
  })

  it('reads a host with no GPU probe as unknown, never as zero bytes', () => {
    const plan = planFleetPlacement(
      [member(big, 'fp-nogpu', measuredSample(24 * GB), { nodeResources: resources() })],
      { ...request, ...vramNeed(1) }
    )

    expect(reasonsOf(plan, 'fp-nogpu')).toEqual([
      { reason: 'resource-unknown', family: 'vram', cause: 'unmeasured', detail: 'no-gpu-tool' }
    ])
  })

  it('reads a GPU reading older than its trust window as stale and never compares it', () => {
    const plan = planFleetPlacement(
      [
        member(big, 'fp-stale', measuredSample(24 * GB), {
          nodeResources: resources({ gpu: gpu(20 * GB) }, NOW - 60_001)
        })
      ],
      { ...request, ...vramNeed(8 * GB) }
    )

    expect(plan.decision).toBe('no-eligible-host')
    expect(reasonsOf(plan, 'fp-stale')).toEqual([
      {
        reason: 'resource-unknown',
        family: 'vram',
        cause: 'stale',
        detail: 'measurement older than its max age'
      }
    ])
  })

  it('D-13: excludes the most-free-memory host with unknown VRAM and selects measured VRAM', () => {
    const hosts = () => [
      member(big, 'fp-rich', measuredSample(48 * GB)),
      member(mid, 'fp-gpu', measuredSample(10 * GB), {
        nodeResources: resources({ gpu: gpu(12 * GB) })
      })
    ]
    const withVram = planFleetPlacement(hosts(), { ...request, ...vramNeed(8 * GB) })

    expect(withVram.selected?.fingerprint).toBe('fp-gpu')
    expect(reasonsOf(withVram, 'fp-rich')?.map((r) => r.reason)).toEqual(['resource-unknown'])

    // Control: without the VRAM need the same fleet picks the richest host by memory.
    expect(planFleetPlacement(hosts(), request).selected?.fingerprint).toBe('fp-rich')
  })

  it('judges on facts, not on isCurrent, label or address', () => {
    const plan = planFleetPlacement(
      [
        member(LOCAL_EXECUTION_HOST_ID, 'fp-self', measuredSample(48 * GB)),
        member(mid, 'fp-gpu', measuredSample(10 * GB), {
          nodeResources: resources({ gpu: gpu(12 * GB) })
        })
      ],
      { ...request, ...vramNeed(8 * GB), currentFingerprint: 'fp-self' }
    )

    expect(plan.selected?.fingerprint).toBe('fp-gpu')
  })

  it('judges the recorded GEX44 reading: rejected for 8 GiB, selected for 2 GiB', () => {
    // Why: figures recorded in docs/dws/phase-5-node-manifest.md (fan-out-gex44, 2026-10-14); totals were not recorded.
    const recordedMemoryAvailable = 59193368576
    const recordedVramFree = 3245342720
    const gex44 = () =>
      member(big, 'fp-gex44', measuredSample(recordedMemoryAvailable), {
        nodeResources: resources({ gpu: gpu(recordedVramFree) })
      })

    const tooBig = planFleetPlacement([gex44()], {
      ...request,
      requirement: { memory: { minAvailableBytes: 8 * GB }, vram: { minFreeBytes: 8 * GB } }
    })
    expect(reasonsOf(tooBig, 'fp-gex44')).toEqual([
      { reason: 'insufficient-vram', freeBytes: 3245342720, required: 8 * GB }
    ])

    const fits = planFleetPlacement([gex44()], {
      ...request,
      requirement: { memory: { minAvailableBytes: 8 * GB }, vram: { minFreeBytes: 2 * GB } }
    })
    expect(fits.selected).toMatchObject({ fingerprint: 'fp-gex44', availableMemory: 59193368576 })
  })
})

describe('disk and resident model requirement', () => {
  const diskOf = (availableBytes: number): FleetNodeResourcesObservation['disk'] => ({
    outcome: 'measured',
    filesystems: [{ path: '/', totalBytes: 1000 * GB, availableBytes }]
  })

  it('rejects free disk below the need and selects enough disk', () => {
    const plan = planFleetPlacement(
      [
        member(mid, 'fp-full', measuredSample(8 * GB), {
          nodeResources: resources({ disk: diskOf(5 * GB) })
        }),
        member(big, 'fp-roomy', measuredSample(8 * GB), {
          nodeResources: resources({ disk: diskOf(500 * GB) })
        })
      ],
      { ...request, requirement: { disk: { minAvailableBytes: 100 * GB } } }
    )

    expect(plan.selected?.fingerprint).toBe('fp-roomy')
    expect(reasonsOf(plan, 'fp-full')).toEqual([
      { reason: 'insufficient-disk', availableBytes: 5 * GB, required: 100 * GB }
    ])
  })

  it('reads a requested path that was not measured as resource-unknown path-not-measured', () => {
    const plan = planFleetPlacement(
      [
        member(big, 'fp-a', measuredSample(8 * GB), {
          nodeResources: resources({ disk: diskOf(500 * GB) })
        })
      ],
      { ...request, requirement: { disk: { minAvailableBytes: 1, path: '/data' } } }
    )

    expect(reasonsOf(plan, 'fp-a')).toEqual([
      { reason: 'resource-unknown', family: 'disk', cause: 'path-not-measured', detail: '/data' }
    ])
  })

  it('rejects a model absent from fully answering endpoints, selects a host serving it', () => {
    const serving = (modelIds: string[], unansweredPorts: number[] = []) =>
      resources({
        models: { outcome: 'measured', endpoints: [{ port: 8081, modelIds }], unansweredPorts }
      })
    const plan = planFleetPlacement(
      [
        member(mid, 'fp-other', measuredSample(8 * GB), { nodeResources: serving(['llama-3']) }),
        member(big, 'fp-has', measuredSample(8 * GB), {
          nodeResources: serving(['qwen3-coder-30b'])
        })
      ],
      { ...request, requirement: { residentModel: { modelId: 'qwen3-coder-30b' } } }
    )

    expect(plan.selected?.fingerprint).toBe('fp-has')
    expect(reasonsOf(plan, 'fp-other')).toEqual([
      { reason: 'model-not-resident', modelId: 'qwen3-coder-30b' }
    ])

    const maybe = planFleetPlacement(
      [
        member(mid, 'fp-other', measuredSample(8 * GB), {
          nodeResources: serving(['llama-3'], [8082])
        })
      ],
      { ...request, requirement: { residentModel: { modelId: 'qwen3-coder-30b' } } }
    )
    expect(reasonsOf(maybe, 'fp-other')).toEqual([
      {
        reason: 'resource-unknown',
        family: 'residentModel',
        cause: 'unmeasured',
        detail: 'some probed ports did not answer'
      }
    ])
  })
})

describe('transports without node resources (D-06)', () => {
  it('gives a local, a runtime and an ssh-hostkey member resource-unknown for a VRAM need', () => {
    // Why: the not-dispatchable refusal for the SSH relay member is covered by the mission placement plan (04-03).
    const sshHost = toSshExecutionHostId('target-1')
    const plan = planFleetPlacement(
      [
        member(LOCAL_EXECUTION_HOST_ID, 'fp-local', measuredSample(16 * GB)),
        member(mid, 'fp-runtime', measuredSample(16 * GB)),
        member(sshHost, 'ssh-hostkey:SHA256:abc', measuredSample(16 * GB))
      ],
      { ...request, ...vramNeed(1 * GB) }
    )

    expect(plan.decision).toBe('no-eligible-host')
    for (const fingerprint of ['fp-local', 'fp-runtime', 'ssh-hostkey:SHA256:abc']) {
      expect(reasonsOf(plan, fingerprint)).toEqual([
        { reason: 'resource-unknown', family: 'vram', cause: 'unmeasured', detail: 'not-attempted' }
      ])
    }
    expect(eligibleOf(plan)).toEqual([])
  })

  it('does not mistake a malformed measured memory sample for enough memory', () => {
    const plan = planFleetPlacement([member(big, 'fp-bad', measuredSample(1.5))], {
      ...request,
      requirement: { memory: { minAvailableBytes: 1 } }
    })

    expect(plan.decision).toBe('no-eligible-host')
    expect(reasonsOf(plan, 'fp-bad')).toEqual([
      expect.objectContaining({ reason: 'resource-unknown', family: 'memory', cause: 'unmeasured' })
    ])
  })
})
