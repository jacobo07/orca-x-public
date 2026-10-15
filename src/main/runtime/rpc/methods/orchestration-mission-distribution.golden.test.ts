// Golden for automatic distribution at the missionPlace handler; the live two-host proof is tests/e2e/hwf-two-host-mission-placement.spec.ts, which exercises planMissionPlacement, not this RPC.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FleetObservation } from '../../../../shared/fleet-placement-view'
import type { FleetPlacementMember } from '../../../../shared/fleet-placement'
import {
  ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY,
  ORCHESTRATION_FEDERATION_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'
import type { OrchestrationDb } from '../../orchestration/db'
import { createOrchestrationRpcHarness } from './orchestration-rpc-test-harness'

const observation = vi.hoisted(() => ({ current: null as Promise<unknown> | null }))
vi.mock('../../../fleet/fleet-observation-slot', () => ({
  readFleetObservation: () => observation.current,
  installFleetObservation: () => {}
}))

const GB = 1024 ** 3
const FED = [ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY, ORCHESTRATION_FEDERATION_RUNTIME_CAPABILITY]
const NO_VRAM_PROBE = {
  reason: 'resource-unknown',
  family: 'vram',
  cause: 'unmeasured',
  detail: 'not-attempted'
}

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
      startedAt: 1_000,
      totalMemory: availableMemory,
      availableMemory,
      availableMemorySource: 'unknown',
      processSweep: 'unknown'
    }
  }
}

function withMeasuredGpu(base: FleetPlacementMember, freeBytes: number): FleetPlacementMember {
  return {
    ...base,
    nodeResources: {
      startedAt: 1_000,
      runtimeId: null,
      disk: { outcome: 'unknown', reason: 'not-attempted' },
      gpu: { outcome: 'measured', gpus: [{ name: 'gpu0', totalBytes: 24 * GB, freeBytes }] },
      models: { outcome: 'unknown', reason: 'no-probe-configured' }
    }
  }
}

// Why: the relay has the most memory, so a filter that lets it through would hand it work.
function distributionFleet(vramProven: boolean): FleetPlacementMember[] {
  const a = member('runtime:env-a', 'fp-a', FED, 24 * GB)
  return [
    member('local', 'fp-local', null, 16 * GB),
    vramProven ? withMeasuredGpu(a, 12 * GB) : a,
    member('runtime:env-b', 'fp-b', FED, 6 * GB),
    member('ssh:relay', 'ssh-hostkey:relay', null, 64 * GB)
  ]
}

const NAMES = ['t1', 't2', 't3', 't4'] as const
type TaskName = (typeof NAMES)[number]
type Mapping = Record<TaskName, string | undefined>

// Why: t1 -> A, t2 -> A, t3 -> local, t4 -> B follows from the rules alone; the planner orders jobs by id.
const GOLDEN_MAPPING: Mapping = {
  t1: 'runtime:env-a',
  t2: 'runtime:env-a',
  t3: 'local',
  t4: 'runtime:env-b'
}

type Rejection = { fingerprint: string | null; reasons: unknown[] }
type PlaceResult = {
  runId: string
  placements: { taskId: string }[]
  unplaced: { jobId: string; reason: string }[]
  rejectedByJob: { jobId: string; rejected: Rejection[] }[]
  notDispatchable: { address: string }[]
  hostCount: number
}

describe('automatic mission distribution golden', () => {
  const h = createOrchestrationRpcHarness()

  afterEach(() => {
    observation.current = null
    h.cleanup()
  })

  type Scenario = {
    members: FleetPlacementMember[]
    orderTasks?: (ids: string[]) => string[]
  }

  async function place(scenario: Scenario) {
    h.cleanup()
    const { db, ctx } = h.setup(true)
    observation.current = Promise.resolve({
      observedAt: 1_000,
      completedAt: 1_000,
      members: scenario.members,
      coverage: { runtimeEnvironments: 2, sshTargets: 'enumerated' }
    } satisfies FleetObservation)
    // Why: task ids are random, so t1..t4 name the sorted-id positions the planner orders by.
    const ids = NAMES.map((_, i) => db.createTask({ spec: `job ${i}` }).id).sort()
    const idOf = Object.fromEntries(NAMES.map((name, i) => [name, ids[i]])) as Record<
      TaskName,
      string
    >
    const params = {
      from: 'term_coord',
      tasks: scenario.orderTasks ? scenario.orderTasks(ids) : ids,
      taskRequirements: {
        [idOf.t1]: { memory: { minAvailableBytes: 8 * GB } },
        [idOf.t2]: { vram: { minFreeBytes: 8 * GB } }
      }
    }
    const plan = (await h.call('orchestration.missionPlace', params, ctx)) as PlaceResult
    return { db, ctx, plan, idOf, params, mapping: persistedMapping(db, idOf) }
  }

  function persistedMapping(db: OrchestrationDb, idOf: Record<TaskName, string>): Mapping {
    return Object.fromEntries(
      NAMES.map((name) => [name, db.getTaskPlacement(idOf[name])?.address])
    ) as Mapping
  }

  function rejectionFor(plan: PlaceResult, id: string): Rejection[] {
    return plan.rejectedByJob.find((entry) => entry.jobId === id)?.rejected ?? []
  }

  it('places four tasks over three hosts and a relay with no host choice, read from persisted rows', async () => {
    const { db, plan, idOf, params, mapping } = await place({
      members: distributionFleet(true)
    })

    expect(mapping).toEqual(GOLDEN_MAPPING)
    expect(plan.unplaced).toEqual([])
    expect(plan.hostCount).toBe(3)
    expect(plan.notDispatchable.map((m) => m.address)).toEqual(['ssh:relay'])
    const rows = db.listRunTaskPlacements(plan.runId)
    expect(rows).toHaveLength(4)
    expect(rows.map((row) => row.address)).not.toContain('ssh:relay')
    expect(db.getTaskPlacement(idOf.t1)).toMatchObject({ fingerprint: 'fp-a' })
    expect(db.getTaskPlacement(idOf.t3)).toMatchObject({ fingerprint: 'fp-local' })
    expect(db.getTaskPlacement(idOf.t4)).toMatchObject({ fingerprint: 'fp-b' })

    // B refuses t1 on memory with both figures; local and B cannot prove the VRAM t2 needs.
    expect(rejectionFor(plan, idOf.t1)).toMatchObject([
      {
        fingerprint: 'fp-b',
        reasons: [{ reason: 'insufficient-memory', availableMemory: 6 * GB, required: 8 * GB }]
      }
    ])
    const t2 = rejectionFor(plan, idOf.t2)
    expect(t2.map((r) => r.fingerprint).sort()).toEqual(['fp-b', 'fp-local'])
    for (const host of t2) {
      expect(host.reasons).toEqual([NO_VRAM_PROBE])
    }
    expect(rejectionFor(plan, idOf.t3)).toEqual([])
    expect(rejectionFor(plan, idOf.t4)).toEqual([])

    // Control: the params carry no host field, and adding one is refused by the strict schema.
    expect(Object.keys(params)).toEqual(['from', 'tasks', 'taskRequirements'])
    const other = await place({ members: distributionFleet(true) })
    await expect(
      h.call('orchestration.missionPlace', { ...other.params, host: 'runtime:env-b' }, other.ctx)
    ).rejects.toThrow(/Unrecognized key/)
    expect(other.mapping).toEqual(GOLDEN_MAPPING)
  })

  describe('determinism and unproven VRAM', () => {
    const rotations = <T>(items: T[]): T[][] =>
      items.map((_, shift) => [...items.slice(shift), ...items.slice(0, shift)])

    it('keeps the full mapping under every rotation and the reverse of the fleet members', async () => {
      const base = distributionFleet(true)
      const orders = [...rotations(base), base.toReversed()]
      expect(orders).toHaveLength(5)
      for (const members of orders) {
        const { mapping, plan } = await place({ members })
        expect(mapping).toEqual(GOLDEN_MAPPING)
        expect(plan.hostCount).toBe(3)
      }
    })

    it('keeps the full mapping under the reverse and every rotation of the task list', async () => {
      const orders: ((ids: string[]) => string[])[] = [
        (ids) => ids.toReversed(),
        ...[1, 2, 3].map((shift) => (ids: string[]) => [
          ...ids.slice(shift),
          ...ids.slice(0, shift)
        ])
      ]
      for (const orderTasks of orders) {
        const { mapping } = await place({ members: distributionFleet(true), orderTasks })
        expect(mapping).toEqual(GOLDEN_MAPPING)
      }
    })

    it('leaves the VRAM task unplaced when no host proves it and still places the other three', async () => {
      const { plan, idOf, mapping, db } = await place({ members: distributionFleet(false) })

      expect(plan.unplaced).toEqual([{ jobId: idOf.t2, reason: 'no-eligible-host' }])
      expect(mapping).toEqual({
        t1: 'runtime:env-a',
        t2: undefined,
        t3: 'local',
        t4: 'runtime:env-b'
      })
      expect(db.getTaskPlacement(idOf.t2)).toBeUndefined()
      const t2 = rejectionFor(plan, idOf.t2)
      expect(t2.map((r) => r.fingerprint).sort()).toEqual(['fp-a', 'fp-b', 'fp-local'])
      for (const host of t2) {
        expect(host.reasons).toEqual([NO_VRAM_PROBE])
      }
      expect(plan.notDispatchable.map((m) => m.address)).toEqual(['ssh:relay'])
      expect(db.listRunTaskPlacements(plan.runId).map((row) => row.address)).not.toContain(
        'ssh:relay'
      )
    })
  })
})
