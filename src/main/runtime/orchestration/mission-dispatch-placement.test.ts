import { describe, expect, it } from 'vitest'
import type { FleetPlacementMember } from '../../../shared/fleet-placement'
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
