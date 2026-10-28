import { describe, expect, it, vi } from 'vitest'
import { observeFleet, type FleetObservationDeps } from './fleet-observation-service'
import { observeSshPlacementMembers, type FleetSshMemberDeps } from './fleet-ssh-placement-member'
import { planFleetPlacement } from '../../shared/fleet-placement'
import type { FleetSshHostObservation } from '../../shared/fleet-placement-view'
import { FLEET_RESOURCES_RELAY_CAPABILITY } from '../../shared/fleet-relay-resources'

const PIN = 'SHA256:abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ'
const GIB = 1024 ** 3

function measured(
  capabilities: string[] = [FLEET_RESOURCES_RELAY_CAPABILITY]
): FleetSshHostObservation {
  return {
    targetId: 't1',
    address: 'ssh:t1',
    label: 'GEX44',
    outcome: 'measured',
    observedAt: 1_000,
    answeredAt: 1_001,
    relayUptimeMs: 5,
    relayCapabilities: capabilities
  }
}

const REPLY = {
  platform: 'linux',
  arch: 'x64',
  host: { totalMemory: 64 * GIB, availableMemory: 40 * GIB, availableMemorySource: 'proc-meminfo' }
}

function deps(over: Partial<FleetSshMemberDeps> = {}): FleetSshMemberDeps {
  return {
    now: () => 2_000,
    call: vi.fn(async () => REPLY),
    readPinnedFingerprint: () => PIN,
    deadlineMs: 50,
    ...over
  }
}

const REQUEST = { now: 2_000, maxSampleAgeMs: 60_000 }

describe('SSH placement members', () => {
  it('control: a connected, pinned target whose relay measures is an eligible host keyed by its host key', async () => {
    const [member] = await observeSshPlacementMembers([measured()], deps())
    expect(member.identity).toEqual({ state: 'keyed', fingerprint: `ssh-hostkey:${PIN}` })
    expect(member.sample).toMatchObject({ outcome: 'measured', availableMemory: 40 * GIB })
    expect(member.facts).toMatchObject({ platform: 'linux', protocol: 'not-applicable' })
    const plan = planFleetPlacement([member], REQUEST)
    expect(plan.eligible.map((c) => c.key)).toEqual([`fingerprint:ssh-hostkey:${PIN}`])
  })

  it('an unpinned target is a member but never eligible', async () => {
    const [member] = await observeSshPlacementMembers(
      [measured()],
      deps({ readPinnedFingerprint: () => null })
    )
    const plan = planFleetPlacement([member], REQUEST)
    expect(plan.eligible).toEqual([])
    expect(plan.rejected[0].reasons).toContainEqual({ reason: 'identity-unavailable' })
  })

  it('an older relay is never sent the method and reads unsupported, not zero', async () => {
    const call = vi.fn(async () => REPLY)
    const [member] = await observeSshPlacementMembers([measured(['skills.v1'])], deps({ call }))
    expect(call).not.toHaveBeenCalled()
    expect(member.sample.outcome).toBe('unsupported')
    expect(member.sample).not.toHaveProperty('availableMemory')
    const plan = planFleetPlacement([member], REQUEST)
    expect(plan.rejected[0].reasons).toContainEqual({
      reason: 'sample-unmeasured',
      outcome: 'unsupported'
    })
  })

  it('a failed or silent relay reads unreachable', async () => {
    const thrown = await observeSshPlacementMembers(
      [measured()],
      deps({
        call: async () => {
          throw new Error('mux closed')
        }
      })
    )
    expect(thrown[0].sample).toMatchObject({ outcome: 'unreachable', detail: 'mux closed' })
    const silent = await observeSshPlacementMembers(
      [measured()],
      deps({ call: () => new Promise(() => undefined) })
    )
    expect(silent[0].sample).toMatchObject({
      outcome: 'unreachable',
      detail: 'no answer within 50 ms'
    })
  })

  it('a reply without byte counts reads malformed', async () => {
    const [member] = await observeSshPlacementMembers(
      [measured()],
      deps({ call: async () => ({ platform: 'linux', host: { totalMemory: -1 } }) })
    )
    expect(member.sample.outcome).toBe('malformed')
  })

  it('a target that is not connected stays out of the members', async () => {
    const unknown: FleetSshHostObservation = {
      targetId: 't2',
      address: 'ssh:t2',
      label: 'off',
      outcome: 'unknown',
      observedAt: 1,
      reason: 'not-connected',
      connection: 'disconnected',
      detail: 'connection is disconnected'
    }
    expect(await observeSshPlacementMembers([unknown], deps())).toEqual([])
  })
})

describe('observeFleet with SSH members', () => {
  function fleetDeps(over: Partial<FleetObservationDeps> = {}): FleetObservationDeps {
    return {
      now: () => 2_000,
      readLocalPublicKey: () => undefined,
      getLocalStatus: () => ({ runtimeId: 'local-rt' }),
      collectLocalSnapshot: async () => ({
        host: {
          totalMemory: 16 * GIB,
          availableMemory: 8 * GIB,
          availableMemorySource: 'free-memory'
        }
      }),
      listEnvironments: () => [],
      callEnvironment: async () => {
        throw new Error('no environments')
      },
      listSshTargets: () => [{ id: 't1', label: 'GEX44', status: 'connected' }],
      callSshRelay: async ({ method }) =>
        method === 'relay.status'
          ? { uptimeMs: 5, capabilities: [FLEET_RESOURCES_RELAY_CAPABILITY] }
          : REPLY,
      readPinnedSshHostKeyFingerprint: () => PIN,
      ...over
    }
  }

  it('adds the connected, pinned SSH target as a placement member that the plan can select', async () => {
    const observation = await observeFleet(fleetDeps({ readLocalPublicKey: () => null }))
    expect(observation.members.map((m) => m.address)).toEqual(['local', 'ssh:t1'])
    expect(observation.coverage.sshHosts?.[0].outcome).toBe('measured')
    const plan = planFleetPlacement(observation.members, REQUEST)
    expect(plan.eligible.map((c) => c.evidenceAddress)).toEqual(['ssh:t1'])
    // Why: the local key is unreadable here, so only the SSH host can be ranked.
    expect(plan.rejected.map((r) => r.addresses)).toEqual([['local']])
  })

  it('without the pin reader the members are exactly the old ones', async () => {
    const observation = await observeFleet(
      fleetDeps({ readPinnedSshHostKeyFingerprint: undefined })
    )
    expect(observation.members.map((m) => m.address)).toEqual(['local'])
  })
})
