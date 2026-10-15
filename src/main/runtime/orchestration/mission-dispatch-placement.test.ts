import { describe, expect, it } from 'vitest'
import { planFleetPlacement, type FleetPlacementMember } from '../../../shared/fleet-placement'
import type { FleetNodeResourcesObservation } from '../../../shared/node-resources'
import {
  ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY,
  ORCHESTRATION_FEDERATION_RUNTIME_CAPABILITY
} from '../../../shared/protocol-version'
import {
  assertWorkerStartMatchesPlacement,
  dispatchRanOnPlacement,
  isDispatchableMember,
  planDispatchableMission
} from './mission-dispatch-placement'
import type { DispatchContextRow, FederatedDispatchRow, TaskPlacementRow } from './types'

describe('dispatchRanOnPlacement', () => {
  const dispatch = { id: 'disp-1' } as DispatchContextRow
  const federatedTo = (environmentId: string, peerFingerprint: string) =>
    ({
      dispatch_id: 'disp-1',
      environment_id: environmentId,
      peer_fingerprint: peerFingerprint
    }) as FederatedDispatchRow

  it('needs a dispatch at all', () => {
    expect(dispatchRanOnPlacement(placement('local', 'fp-win'), undefined, undefined)).toBe(false)
  })

  it('credits a local placement only for a non-federated dispatch', () => {
    expect(dispatchRanOnPlacement(placement('local', 'fp-win'), dispatch, undefined)).toBe(true)
    expect(
      dispatchRanOnPlacement(
        placement('local', 'fp-win'),
        dispatch,
        federatedTo('env-gex', 'fp-gex')
      )
    ).toBe(false)
  })

  it('credits a runtime placement only for federation to that runtime with its key', () => {
    const remote = placement('runtime:env-gex', 'fp-gex')
    expect(dispatchRanOnPlacement(remote, dispatch, federatedTo('env-gex', 'fp-gex'))).toBe(true)
    expect(dispatchRanOnPlacement(remote, dispatch, undefined)).toBe(false)
    expect(dispatchRanOnPlacement(remote, dispatch, federatedTo('env-other', 'fp-gex'))).toBe(false)
    expect(dispatchRanOnPlacement(remote, dispatch, federatedTo('env-gex', 'fp-new'))).toBe(false)
  })
})

const NOW = 1_000_000

function member(
  address: FleetPlacementMember['address'],
  fingerprint: string,
  capabilities: string[] | null,
  availableMemory: number
): FleetPlacementMember {
  return {
    address,
    label: address,
    identity: { state: 'keyed', fingerprint },
    facts: { runtimeId: null, platform: 'linux', capabilities, protocol: 'not-applicable' },
    sample: {
      outcome: 'measured',
      runtimeId: null,
      startedAt: NOW,
      totalMemory: availableMemory,
      availableMemory,
      availableMemorySource: 'unknown',
      processSweep: 'unknown'
    }
  }
}

const GB = 1024 ** 3

function withGpu(
  base: FleetPlacementMember,
  gpu: FleetNodeResourcesObservation['gpu']
): FleetPlacementMember {
  return {
    ...base,
    nodeResources: {
      startedAt: NOW,
      runtimeId: null,
      disk: { outcome: 'unknown', reason: 'not-attempted' },
      gpu,
      models: { outcome: 'unknown', reason: 'no-probe-configured' }
    }
  }
}
const gpuFree = (freeBytes: number): FleetNodeResourcesObservation['gpu'] => ({
  outcome: 'measured',
  gpus: [{ name: 'gpu0', totalBytes: 24 * GB, freeBytes }]
})

const FED = [ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY, ORCHESTRATION_FEDERATION_RUNTIME_CAPABILITY]

function placement(address: string, fingerprint: string): TaskPlacementRow {
  return {
    task_id: 'task-a',
    run_id: 'run-1',
    host_key: `fingerprint:${fingerprint}`,
    fingerprint,
    address,
    label: address,
    placed_at: '2026-10-14 00:00:00'
  }
}

function refusal(run: () => void): { code?: string; data?: unknown } | null {
  try {
    run()
    return null
  } catch (error) {
    return error as { code?: string; data?: unknown }
  }
}

describe('isDispatchableMember', () => {
  it('admits this host and a federation-capable runtime', () => {
    expect(isDispatchableMember(member('local', 'fp-win', null, 1))).toBe(true)
    expect(isDispatchableMember(member('runtime:env-gex', 'fp-gex', FED, 1))).toBe(true)
  })

  it('refuses an SSH relay and a runtime without federation', () => {
    expect(isDispatchableMember(member('ssh:gex', 'ssh-hostkey:x', FED, 1))).toBe(false)
    expect(
      isDispatchableMember(
        member('runtime:old', 'fp-old', [ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY], 1)
      )
    ).toBe(false)
    expect(isDispatchableMember(member('runtime:mute', 'fp-mute', null, 1))).toBe(false)
  })
})

describe('planDispatchableMission', () => {
  it('spreads two jobs over this host and the runtime, never the SSH relay', () => {
    const plan = planDispatchableMission(
      ['job-a', 'job-b'],
      [
        member('local', 'fp-win', null, 4),
        // Why: the relay has the most memory, so a plan that kept it would pick it first.
        member('ssh:gex', 'ssh-hostkey:x', null, 64),
        member('runtime:env-gex', 'fp-gex', FED, 32)
      ],
      { now: NOW, maxSampleAgeMs: 60_000 }
    )
    expect(plan.hostCount).toBe(2)
    expect(plan.placements.map((p) => p.address).sort()).toEqual(['local', 'runtime:env-gex'])
    expect(plan.notDispatchable).toEqual([
      { address: 'ssh:gex', label: 'ssh:gex', reason: 'not-dispatchable' }
    ])
  })
})

describe('planDispatchableMission with a resource requirement', () => {
  const vram = { vram: { minFreeBytes: 8 * GB } }
  const request = { now: NOW, maxSampleAgeMs: 60_000 }
  // Why: two hosts that can prove the VRAM, one that proves too little, one that cannot say, and a relay that could.
  const hosts = () => [
    withGpu(member('local', 'fp-win', null, 16 * GB), gpuFree(16 * GB)),
    withGpu(member('runtime:env-gex', 'fp-gex', FED, 32 * GB), gpuFree(20 * GB)),
    withGpu(member('runtime:env-weak', 'fp-weak', FED, 64 * GB), gpuFree(2 * GB)),
    member('runtime:env-mute', 'fp-mute', FED, 64 * GB),
    withGpu(member('ssh:big', 'ssh-hostkey:big', FED, 128 * GB), gpuFree(24 * GB))
  ]

  it('agrees with the proposal view on eligible hosts and on every rejection reason', () => {
    const members = hosts()
    const dispatchable = members.filter(isDispatchableMember)
    const proposal = planFleetPlacement(dispatchable, { ...request, requirement: vram })
    const plan = planDispatchableMission(['job-a', 'job-b'], members, request, {
      requirements: { 'job-a': vram, 'job-b': vram }
    })

    expect(proposal.eligible.map((c) => c.key).sort()).toEqual([
      'fingerprint:fp-gex',
      'fingerprint:fp-win'
    ])
    expect(plan.placements.map((p) => p.hostKey).sort()).toEqual(
      proposal.eligible.map((c) => c.key).sort()
    )
    const reasons = (rejected: typeof proposal.rejected) =>
      Object.fromEntries(rejected.map((r) => [r.key, r.reasons]))
    expect(reasons(plan.rejectedByJob[0].rejected)).toEqual(reasons(proposal.rejected))
    expect(reasons(proposal.rejected)).toEqual({
      'fingerprint:fp-weak': [{ reason: 'insufficient-vram', freeBytes: 2 * GB, required: 8 * GB }],
      'fingerprint:fp-mute': [
        { reason: 'resource-unknown', family: 'vram', cause: 'unmeasured', detail: 'not-attempted' }
      ]
    })
  })

  it('control: a 1 GiB VRAM need leaves the weak host eligible in both views', () => {
    const members = hosts()
    const need = { vram: { minFreeBytes: 1 * GB } }
    const proposal = planFleetPlacement(members.filter(isDispatchableMember), {
      ...request,
      requirement: need
    })
    const plan = planDispatchableMission(['a', 'b', 'c'], members, request, {
      requirements: { a: need, b: need, c: need }
    })
    expect(proposal.eligible.map((c) => c.fingerprint).sort()).toEqual([
      'fp-gex',
      'fp-weak',
      'fp-win'
    ])
    expect(new Set(plan.placements.map((p) => p.fingerprint))).toEqual(
      new Set(['fp-gex', 'fp-weak', 'fp-win'])
    )
  })

  it('a task with no entry inherits the request requirement; an entry overrides it', () => {
    const plan = planDispatchableMission(
      ['a', 'b'],
      hosts(),
      { ...request, requirement: vram },
      {
        requirements: { b: { vram: { minFreeBytes: 1 * GB } } }
      }
    )
    const refusedBy = (jobId: string) =>
      plan.rejectedByJob
        .find((e) => e.jobId === jobId)
        ?.rejected.map((r) => r.fingerprint)
        .sort()
    expect(refusedBy('a')).toEqual(['fp-mute', 'fp-weak'])
    expect(refusedBy('b')).toEqual(['fp-mute'])
  })

  it('refuses a relay and a runtime without federation whatever their resources, and places the local host', () => {
    const noFederation = withGpu(
      member('runtime:env-old', 'fp-old', [ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY], 256 * GB),
      gpuFree(24 * GB)
    )
    const relay = withGpu(member('ssh:gex', 'ssh-hostkey:x', FED, 256 * GB), gpuFree(24 * GB))
    const local = withGpu(member('local', 'fp-win', null, 16 * GB), gpuFree(16 * GB))
    const runtime = withGpu(member('runtime:env-gex', 'fp-gex', FED, 32 * GB), gpuFree(20 * GB))
    const jobs = ['a', 'b', 'c', 'd']
    const plan = planDispatchableMission(jobs, [relay, noFederation, local, runtime], request, {
      requirements: Object.fromEntries(jobs.map((j) => [j, vram]))
    })
    expect(plan.notDispatchable.map((m) => [m.address, m.reason]).sort()).toEqual([
      ['runtime:env-old', 'not-dispatchable'],
      ['ssh:gex', 'not-dispatchable']
    ])
    expect(new Set(plan.placements.map((p) => p.address))).toEqual(
      new Set(['local', 'runtime:env-gex'])
    )
    expect(plan.placements).toHaveLength(4)
  })

  it('a placement derived from a requirement still refuses at the effect when the key changed', () => {
    const plan = planDispatchableMission(['job-a'], hosts(), request, {
      requirements: { 'job-a': { vram: { minFreeBytes: 18 * GB } } }
    })
    const placed = plan.placements[0]
    expect(placed.address).toBe('runtime:env-gex')
    const row = { ...placement(placed.address, placed.fingerprint), task_id: 'job-a' }

    expect(
      refusal(() =>
        assertWorkerStartMatchesPlacement(row, {
          environmentId: 'env-gex',
          peerFingerprint: 'fp-gex'
        })
      )
    ).toBeNull()
    const changed = refusal(() =>
      assertWorkerStartMatchesPlacement(row, {
        environmentId: 'env-gex',
        peerFingerprint: 'fp-new'
      })
    )
    expect(changed?.code).toBe('placement_mismatch')
    expect(changed?.data).toMatchObject({ reason: 'peer-fingerprint-changed' })
  })
})

describe('assertWorkerStartMatchesPlacement', () => {
  const remote = { environmentId: 'env-gex', peerFingerprint: 'fp-gex' }

  it('leaves an unplaced task alone', () => {
    expect(refusal(() => assertWorkerStartMatchesPlacement(undefined, remote))).toBeNull()
  })

  it('accepts the placed host', () => {
    expect(
      refusal(() => assertWorkerStartMatchesPlacement(placement('local', 'fp-win'), null))
    ).toBeNull()
    expect(
      refusal(() =>
        assertWorkerStartMatchesPlacement(placement('runtime:env-gex', 'fp-gex'), remote)
      )
    ).toBeNull()
  })

  it('refuses a local placement started remotely and a remote one started locally', () => {
    expect(
      refusal(() => assertWorkerStartMatchesPlacement(placement('local', 'fp-win'), remote))?.code
    ).toBe('placement_mismatch')
    expect(
      refusal(() => assertWorkerStartMatchesPlacement(placement('runtime:env-gex', 'fp-gex'), null))
        ?.code
    ).toBe('placement_mismatch')
  })

  it('refuses another runtime and a runtime whose key changed', () => {
    expect(
      refusal(() =>
        assertWorkerStartMatchesPlacement(placement('runtime:env-gex', 'fp-gex'), {
          environmentId: 'env-other',
          peerFingerprint: 'fp-gex'
        })
      )?.code
    ).toBe('placement_mismatch')
    const changed = refusal(() =>
      assertWorkerStartMatchesPlacement(placement('runtime:env-gex', 'fp-gex'), {
        environmentId: 'env-gex',
        peerFingerprint: 'fp-new'
      })
    )
    expect(changed?.code).toBe('placement_mismatch')
    expect(changed?.data).toMatchObject({ reason: 'peer-fingerprint-changed' })
  })
})
