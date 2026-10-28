// Golden for the task-graph spread at the missionPlace handler: tasks and their deps are DB rows, the mapping is read from persisted placements.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from '../../../sqlite/sync-database'
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
const HOST_A = 'runtime:env-a'
const HOST_B = 'runtime:env-b'

function member(
  address: FleetPlacementMember['address'],
  fingerprint: string,
  availableMemory: number
): FleetPlacementMember {
  return {
    address,
    label: address,
    identity: { state: 'keyed', fingerprint },
    facts: { runtimeId: null, platform: 'linux', capabilities: FED, protocol: 'not-applicable' },
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

const TWO_HOSTS = [member(HOST_A, 'fp-a', 24 * GB), member(HOST_B, 'fp-b', 16 * GB)]

type Names = readonly string[]
// A dependency is a task name (resolved to an id) or the raw deps text another caller wrote.
type DepsSpec = Record<string, readonly string[] | { raw: string }>

describe('task-graph spread golden', () => {
  const h = createOrchestrationRpcHarness()

  afterEach(() => {
    observation.current = null
    h.cleanup()
  })

  type Scenario = {
    names: Names
    members?: FleetPlacementMember[]
    deps?: DepsSpec
    statuses?: Record<string, string>
    /** Names of the tasks, in the order the call lists them; defaults to the sorted-id order. */
    listOrder?: (names: Names) => string[]
    outsideTask?: string
  }

  // Why: task ids are random and the planner orders jobs by id, so tN names the Nth sorted id.
  function prepare(scenario: Scenario) {
    h.cleanup()
    const { db, ctx, activeRunId } = h.setup(true)
    observation.current = Promise.resolve({
      observedAt: 1_000,
      completedAt: 1_000,
      members: scenario.members ?? TWO_HOSTS,
      coverage: { runtimeEnvironments: 2, sshTargets: 'enumerated' }
    } satisfies FleetObservation)
    const ids = scenario.names.map((_, i) => db.createTask({ spec: `job ${i}` }).id).sort()
    const idOf = Object.fromEntries(scenario.names.map((name, i) => [name, ids[i]]))
    const outsideId = scenario.outsideTask ? db.createTask({ spec: 'outside' }).id : undefined
    const sqlite = (db as unknown as { db: Database.Database }).db
    for (const [name, spec] of Object.entries(scenario.deps ?? {})) {
      const text =
        'raw' in spec
          ? spec.raw
          : JSON.stringify(
              spec.map((dep) => (dep === scenario.outsideTask ? outsideId : idOf[dep]))
            )
      // Why: a dependent task is pending until its dependency completes, as createTask records it.
      sqlite
        .prepare('UPDATE tasks SET deps = ?, status = ? WHERE id = ?')
        .run(text, 'pending', idOf[name])
    }
    for (const [name, status] of Object.entries(scenario.statuses ?? {})) {
      sqlite.prepare('UPDATE tasks SET status = ? WHERE id = ?').run(status, idOf[name])
    }
    const listed = scenario.listOrder ? scenario.listOrder(scenario.names) : [...scenario.names]
    const params = { from: 'term_coord', tasks: listed.map((name) => idOf[name]) }
    return { db, ctx, idOf, params, runId: activeRunId }
  }

  async function place(scenario: Scenario) {
    const { db, ctx, idOf, params } = prepare(scenario)
    const plan = (await h.call('orchestration.missionPlace', params, ctx)) as {
      runId: string
      unplaced: { jobId: string }[]
      hostCount: number
    }
    return { db, ctx, plan, idOf, params, mapping: persistedMapping(db, idOf) }
  }

  function persistedMapping(db: OrchestrationDb, idOf: Record<string, string>) {
    return Object.fromEntries(
      Object.entries(idOf).map(([name, id]) => [name, db.getTaskPlacement(id)?.address])
    )
  }

  it('tracer: a task that depends on another shares its host and the independent task goes to the other host', async () => {
    const { mapping, plan, db, idOf } = await place({
      names: ['t1', 't2', 't3'],
      deps: { t2: ['t1'] }
    })

    expect(mapping).toEqual({ t1: HOST_A, t2: HOST_A, t3: HOST_B })
    expect(plan.unplaced).toEqual([])
    expect(plan.hostCount).toBe(2)
    expect(db.listRunTaskPlacements(plan.runId)).toHaveLength(3)
    expect(db.getTaskPlacement(idOf.t3)).toMatchObject({ fingerprint: 'fp-b' })
    // Control: the persisted rows really carry the dependency the planner read.
    expect(db.getTask(idOf.t2)).toMatchObject({
      status: 'pending',
      deps: JSON.stringify([idOf.t1])
    })
  })

  it('control: the same three tasks with no dependency spread as before', async () => {
    const { mapping } = await place({ names: ['t1', 't2', 't3'] })

    expect(mapping).toEqual({ t1: HOST_A, t2: HOST_B, t3: HOST_A })
  })

  it('a task whose deps text cannot be read is placed as independent and does not fail the call', async () => {
    const { mapping, plan } = await place({
      names: ['t1', 't2'],
      deps: { t2: { raw: 'not json at all' } }
    })

    expect(plan.unplaced).toEqual([])
    expect(mapping).toEqual({ t1: HOST_A, t2: HOST_B })
  })

  describe('independent tasks', () => {
    it('two independent tasks over two eligible hosts land on different hosts', async () => {
      const { mapping, plan } = await place({ names: ['t1', 't2'] })

      expect(mapping).toEqual({ t1: HOST_A, t2: HOST_B })
      expect(plan.hostCount).toBe(2)
    })

    it('three independent tasks over two hosts differ in a pair and no host holds more than two', async () => {
      const { mapping } = await place({ names: ['t1', 't2', 't3'] })

      const hosts = Object.values(mapping)
      expect(new Set(hosts).size).toBe(2)
      for (const host of [HOST_A, HOST_B]) {
        expect(hosts.filter((h) => h === host).length).toBeLessThanOrEqual(Math.ceil(3 / 2))
      }
    })

    it('over one eligible host all tasks share it and none is unplaced', async () => {
      const { mapping, plan } = await place({
        names: ['t1', 't2', 't3'],
        members: [member(HOST_A, 'fp-a', 24 * GB)]
      })

      expect(plan.unplaced).toEqual([])
      expect(mapping).toEqual({ t1: HOST_A, t2: HOST_A, t3: HOST_A })
      expect(plan.hostCount).toBe(1)
    })
  })

  describe('dependency relations', () => {
    it('a transitive chain shares one host and the independent task is not on it', async () => {
      const { mapping } = await place({
        names: ['t1', 't2', 't3', 't4'],
        deps: { t2: ['t1'], t3: ['t2'] }
      })

      expect(mapping).toEqual({ t1: HOST_A, t2: HOST_A, t3: HOST_A, t4: HOST_B })
    })

    it('two tasks that only share a dependency are independent of each other', async () => {
      const { mapping } = await place({
        names: ['t1', 't2', 't3'],
        deps: { t2: ['t1'], t3: ['t1'] }
      })

      expect(mapping).toEqual({ t1: HOST_A, t2: HOST_A, t3: HOST_B })
    })

    it('a dependency on a task outside the call is ignored', async () => {
      const { mapping, plan } = await place({
        names: ['t1', 't2'],
        outsideTask: 'outside',
        deps: { t2: ['outside'] }
      })

      expect(plan.unplaced).toEqual([])
      expect(mapping).toEqual({ t1: HOST_A, t2: HOST_B })
    })

    it('malformed deps text of every shape counts as independent', async () => {
      for (const raw of ['not json', '{"a":1}', '7', '["x",1]', 'null', '']) {
        const { mapping, plan } = await place({ names: ['t1', 't2'], deps: { t2: { raw } } })

        expect(plan.unplaced).toEqual([])
        expect(mapping).toEqual({ t1: HOST_A, t2: HOST_B })
      }
    })

    it('a dependency cycle neither hangs nor throws and its members share a host', async () => {
      const { mapping, plan } = await place({
        names: ['t1', 't2', 't3'],
        deps: { t1: ['t2'], t2: ['t1'] }
      })

      expect(plan.unplaced).toEqual([])
      expect(mapping).toEqual({ t1: HOST_A, t2: HOST_A, t3: HOST_B })
    })
  })

  describe('determinism and placeable states', () => {
    const permutations = <T>(items: readonly T[]): T[][] =>
      items.length <= 1
        ? [[...items]]
        : items.flatMap((item, i) =>
            permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [
              item,
              ...rest
            ])
          )

    it('keeps the full mapping across all 24 orders of a 4-task list and the member order', async () => {
      const names = ['t1', 't2', 't3', 't4']
      const deps: DepsSpec = { t2: ['t1'], t4: ['t3'] }
      const golden = { t1: HOST_A, t2: HOST_A, t3: HOST_B, t4: HOST_B }
      const orders = permutations(names)
      expect(orders).toHaveLength(24)
      for (const order of orders) {
        const { mapping } = await place({ names, deps, listOrder: () => order })
        expect(mapping).toEqual(golden)
      }
      const reversed = await place({ names, deps, members: TWO_HOSTS.toReversed() })
      expect(reversed.mapping).toEqual(golden)
    })

    it('places pending and ready tasks and refuses a dispatched unplaced one before placing anything', async () => {
      const ok = await place({
        names: ['t1', 't2'],
        deps: { t2: ['t1'] },
        statuses: { t1: 'ready' }
      })
      expect(ok.mapping).toEqual({ t1: HOST_A, t2: HOST_A })

      const { db, ctx, params, runId } = prepare({
        names: ['t1', 't2', 't3'],
        deps: { t2: ['t1'] },
        statuses: { t3: 'dispatched' }
      })
      await expect(h.call('orchestration.missionPlace', params, ctx)).rejects.toThrow(
        /only pending or ready tasks can be placed/
      )
      expect(db.listRunTaskPlacements(runId!)).toEqual([])
    })
  })
})
