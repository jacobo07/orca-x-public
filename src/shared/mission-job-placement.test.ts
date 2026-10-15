import { describe, expect, it } from 'vitest'
import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from './execution-host'
import type { FleetPlacementMember } from './fleet-placement'
import {
  integrateMissionResults,
  planMissionPlacement,
  type MissionJob
} from './mission-job-placement'
import type { FleetNodeResourcesObservation } from './node-resources'

const GB = 1024 ** 3
const NOW = 1_000_000
const request = { now: NOW, maxSampleAgeMs: 60_000 }

function member(
  address: ExecutionHostId,
  fp: string | null,
  avail: number | null
): FleetPlacementMember {
  return {
    address,
    label: address,
    identity: fp ? { state: 'keyed', fingerprint: fp } : { state: 'unavailable', reason: 'no-key' },
    sample:
      avail === null
        ? { outcome: 'unreachable', runtimeId: null, startedAt: NOW, detail: 'down' }
        : {
            outcome: 'measured',
            runtimeId: `rt-${address}`,
            startedAt: NOW - 1000,
            totalMemory: 32 * GB,
            availableMemory: avail,
            availableMemorySource: 'free-memory',
            processSweep: 'measured'
          },
    facts: {
      runtimeId: `rt-${address}`,
      platform: 'linux',
      capabilities: ['code'],
      protocol: 'compatible'
    }
  }
}
const gex = toRuntimeExecutionHostId('gex44')

function withGpu(
  base: FleetPlacementMember,
  gpu: FleetNodeResourcesObservation['gpu'] | null
): FleetPlacementMember {
  if (gpu === null) {
    return base
  }
  return {
    ...base,
    nodeResources: {
      startedAt: NOW - 1000,
      runtimeId: base.facts.runtimeId,
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

describe('mission job placement', () => {
  const fleet = [member(LOCAL_EXECUTION_HOST_ID, 'fp-win', 4 * GB), member(gex, 'fp-gex', 20 * GB)]

  it('puts two jobs of one mission on two distinct hosts', () => {
    const plan = planMissionPlacement([{ jobId: 'b' }, { jobId: 'a' }], fleet, request)
    expect(plan.hostCount).toBe(2)
    expect(plan.placements.map((p) => [p.jobId, p.fingerprint])).toEqual([
      ['a', 'fp-gex'],
      ['b', 'fp-win']
    ])
    expect(plan.unplaced).toEqual([])
  })

  it('is deterministic for any input order', () => {
    const jobs = [{ jobId: 'a' }, { jobId: 'b' }, { jobId: 'c' }]
    const one = planMissionPlacement(jobs, fleet, request)
    const two = planMissionPlacement([...jobs].reverse(), [...fleet].reverse(), request)
    expect(two).toEqual(one)
  })

  it('doubles up only after every eligible host holds a job', () => {
    const plan = planMissionPlacement(
      [{ jobId: 'a' }, { jobId: 'b' }, { jobId: 'c' }],
      fleet,
      request
    )
    expect(plan.placements.map((p) => p.fingerprint)).toEqual(['fp-gex', 'fp-win', 'fp-gex'])
  })

  it('never places on an unmeasured or unkeyed host, and says why', () => {
    const plan = planMissionPlacement(
      [{ jobId: 'a' }, { jobId: 'b' }],
      [member(LOCAL_EXECUTION_HOST_ID, 'fp-win', 4 * GB), member(gex, null, 20 * GB)],
      request
    )
    expect(plan.hostCount).toBe(1)
    expect(plan.rejected[0].reasons).toEqual([{ reason: 'identity-unavailable' }])
  })

  it('leaves a job unplaced when no host has its capability', () => {
    const plan = planMissionPlacement(
      [{ jobId: 'a', requiredCapabilities: ['gpu'] }],
      fleet,
      request
    )
    expect(plan.placements).toEqual([])
    expect(plan.unplaced).toEqual([{ jobId: 'a', reason: 'no-eligible-host' }])
  })

  it('integrates results per host and reports cross-host only when two hosts completed', () => {
    const plan = planMissionPlacement([{ jobId: 'a' }, { jobId: 'b' }], fleet, request)
    const partial = integrateMissionResults(plan.placements, [
      { jobId: 'a', status: 'completed', result: 'ok' }
    ])
    expect(partial.pending).toEqual(['b'])
    expect(partial.crossHost).toBe(false)
    const full = integrateMissionResults(plan.placements, [
      { jobId: 'a', status: 'completed', result: 'ok' },
      { jobId: 'b', status: 'completed', result: 'ok' }
    ])
    expect(full.crossHost).toBe(true)
    expect(full.completed).toBe(2)
    expect(full.byHost.map((h) => h.hostKey)).toEqual(['fingerprint:fp-gex', 'fingerprint:fp-win'])
    const failed = integrateMissionResults(plan.placements, [
      { jobId: 'a', status: 'completed' },
      { jobId: 'b', status: 'failed' }
    ])
    expect(failed.crossHost).toBe(false)
    expect(failed.failed).toBe(1)
  })
})

describe('mission job placement by resource requirement', () => {
  const low = toRuntimeExecutionHostId('low')
  const mid = toRuntimeExecutionHostId('mid')
  const high = toRuntimeExecutionHostId('high')
  const fleet = [
    member(low, 'fp-low', 6 * GB),
    member(mid, 'fp-mid', 16 * GB),
    member(high, 'fp-high', 24 * GB)
  ]
  const eightGb = { memory: { minAvailableBytes: 8 * GB } }

  it('keeps a job with a memory need off the low-memory host even when it must double up', () => {
    const plan = planMissionPlacement(
      [
        { jobId: 'a', requirement: eightGb },
        { jobId: 'b', requirement: eightGb },
        { jobId: 'c', requirement: eightGb }
      ],
      fleet,
      request
    )
    expect(plan.placements.map((p) => p.fingerprint)).toEqual(['fp-high', 'fp-mid', 'fp-high'])
  })

  it('control: jobs with no requirement still reach the low-memory host', () => {
    const plan = planMissionPlacement(
      [{ jobId: 'a' }, { jobId: 'b' }, { jobId: 'c' }],
      fleet,
      request
    )
    expect(plan.placements.map((p) => p.fingerprint)).toEqual(['fp-high', 'fp-mid', 'fp-low'])
  })

  it('a job family replaces the request family and leaves the other families inherited', () => {
    const base = { ...request, requirement: { memory: { minAvailableBytes: 20 * GB } } }
    const replaced = planMissionPlacement(
      [{ jobId: 'a', requirement: { memory: { minAvailableBytes: 1 * GB } } }],
      fleet,
      base
    )
    expect(replaced.placements.map((p) => p.fingerprint)).toEqual(['fp-high'])
    expect(replaced.rejectedByJob[0].rejected).toEqual([])

    const inherited = planMissionPlacement(
      [{ jobId: 'a', requirement: { vram: { minFreeBytes: 1 } } }],
      [
        withGpu(member(low, 'fp-low', 6 * GB), gpuFree(20 * GB)),
        withGpu(member(high, 'fp-high', 24 * GB), gpuFree(20 * GB))
      ],
      base
    )
    expect(inherited.placements.map((p) => p.fingerprint)).toEqual(['fp-high'])
    expect(inherited.rejectedByJob[0].rejected.map((r) => r.fingerprint)).toEqual(['fp-low'])
  })

  it('does not let an explicitly undefined job family erase the inherited one', () => {
    const plan = planMissionPlacement([{ jobId: 'a', requirement: { memory: undefined } }], fleet, {
      ...request,
      requirement: eightGb
    })
    expect(plan.rejectedByJob[0].rejected.map((r) => r.fingerprint)).toEqual(['fp-low'])
  })

  it('places a VRAM job only on the host with measured sufficient VRAM', () => {
    const hosts = [
      withGpu(member(low, 'fp-low', 6 * GB), gpuFree(4 * GB)),
      member(mid, 'fp-mid', 16 * GB),
      withGpu(member(high, 'fp-high', 24 * GB), gpuFree(16 * GB))
    ]
    const need = { vram: { minFreeBytes: 8 * GB } }
    const plan = planMissionPlacement(
      [
        { jobId: 'a', requirement: need },
        { jobId: 'b', requirement: need }
      ],
      hosts,
      request
    )
    expect(plan.placements.map((p) => p.fingerprint)).toEqual(['fp-high', 'fp-high'])
    const reasons = Object.fromEntries(plan.rejected.map((r) => [r.fingerprint, r.reasons]))
    expect(reasons['fp-low']).toEqual([
      { reason: 'insufficient-vram', freeBytes: 4 * GB, required: 8 * GB }
    ])
    expect(reasons['fp-mid']).toEqual([
      { reason: 'resource-unknown', family: 'vram', cause: 'unmeasured', detail: 'not-attempted' }
    ])
  })

  it('leaves a VRAM job unplaced when only unknown-VRAM hosts exist, but still places a light job', () => {
    const plan = planMissionPlacement(
      [{ jobId: 'heavy', requirement: { vram: { minFreeBytes: 1 } } }, { jobId: 'light' }],
      fleet,
      request
    )
    expect(plan.unplaced).toEqual([{ jobId: 'heavy', reason: 'no-eligible-host' }])
    expect(plan.placements.map((p) => p.jobId)).toEqual(['light'])
    const heavy = plan.rejectedByJob.find((entry) => entry.jobId === 'heavy')
    expect(heavy?.rejected).toHaveLength(3)
    for (const host of heavy?.rejected ?? []) {
      expect(host.reasons).toEqual([
        { reason: 'resource-unknown', family: 'vram', cause: 'unmeasured', detail: 'not-attempted' }
      ])
    }
  })

  it('keeps rejection detail per job, for placed and unplaced jobs, and `rejected` is the last job', () => {
    const plan = planMissionPlacement(
      [
        { jobId: 'b' },
        { jobId: 'a', requirement: eightGb },
        { jobId: 'c', requirement: { memory: { minAvailableBytes: 100 * GB } } }
      ],
      fleet,
      request
    )
    expect(plan.rejectedByJob.map((entry) => entry.jobId)).toEqual(['a', 'b', 'c'])
    expect(Object.keys(plan.rejectedByJob[0]).sort()).toEqual(['jobId', 'rejected'])
    const byJob = Object.fromEntries(plan.rejectedByJob.map((e) => [e.jobId, e.rejected]))
    expect(byJob.a.map((r) => r.fingerprint)).toEqual(['fp-low'])
    expect(byJob.b).toEqual([])
    expect(byJob.c).toHaveLength(3)
    expect(plan.unplaced).toEqual([{ jobId: 'c', reason: 'no-eligible-host' }])
    expect(plan.rejected).toEqual(byJob.c)
  })
})

describe('mission job placement: a host that already holds the project', () => {
  const small = toRuntimeExecutionHostId('small')
  const fleet = [
    member(LOCAL_EXECUTION_HOST_ID, 'fp-win', 24 * GB),
    member(small, 'fp-small', 8 * GB)
  ]
  const placedOn = (plan: ReturnType<typeof planMissionPlacement>) =>
    plan.placements.map((p) => [p.jobId, p.fingerprint, p.hydrated])

  it('places a job on the hydrated smaller host ahead of the roomier one', () => {
    const plan = planMissionPlacement([{ jobId: 'a', hydratedAddresses: [small] }], fleet, request)
    expect(placedOn(plan)).toEqual([['a', 'fp-small', true]])
  })

  it('control: a job with no hydration preference goes to the roomier host and says not hydrated', () => {
    const plan = planMissionPlacement([{ jobId: 'a' }], fleet, request)
    expect(placedOn(plan)).toEqual([['a', 'fp-win', false]])
    const empty = planMissionPlacement([{ jobId: 'a', hydratedAddresses: [] }], fleet, request)
    expect(placedOn(empty)).toEqual([['a', 'fp-win', false]])
  })

  it('never makes an ineligible hydrated host a candidate', () => {
    const plan = planMissionPlacement(
      [
        {
          jobId: 'a',
          hydratedAddresses: [small],
          requirement: { memory: { minAvailableBytes: 16 * GB } }
        }
      ],
      fleet,
      request
    )
    expect(placedOn(plan)).toEqual([['a', 'fp-win', false]])
    expect(plan.rejectedByJob[0].rejected.map((r) => r.fingerprint)).toEqual(['fp-small'])
  })

  it('does not rank an unmeasured hydrated host', () => {
    const down = [
      member(LOCAL_EXECUTION_HOST_ID, 'fp-win', 24 * GB),
      member(small, 'fp-small', null)
    ]
    const plan = planMissionPlacement([{ jobId: 'a', hydratedAddresses: [small] }], down, request)
    expect(placedOn(plan)).toEqual([['a', 'fp-win', false]])
  })

  it('treats a hydrated address of any of the host addresses as the host being hydrated', () => {
    const twin = [
      member(LOCAL_EXECUTION_HOST_ID, 'fp-win', 24 * GB),
      member(small, 'fp-small', 8 * GB),
      member(toRuntimeExecutionHostId('small-alias'), 'fp-small', 8 * GB)
    ]
    const plan = planMissionPlacement(
      [{ jobId: 'a', hydratedAddresses: [toRuntimeExecutionHostId('small-alias')] }],
      twin,
      request
    )
    expect(placedOn(plan)).toEqual([['a', 'fp-small', true]])
  })

  it('still spreads: a second hydrated job goes to the unused host only after hydration ranks first', () => {
    const plan = planMissionPlacement(
      [
        { jobId: 'a', hydratedAddresses: [small] },
        { jobId: 'b', hydratedAddresses: [small] }
      ],
      fleet,
      request
    )
    // Why: D-15 ranks hydration above load, so both jobs prefer the host holding the project.
    expect(placedOn(plan)).toEqual([
      ['a', 'fp-small', true],
      ['b', 'fp-small', true]
    ])
  })

  it('is deterministic for any input order with hydration present', () => {
    const jobs: MissionJob[] = [
      { jobId: 'a', hydratedAddresses: [small] },
      { jobId: 'b' },
      { jobId: 'c', hydratedAddresses: [LOCAL_EXECUTION_HOST_ID] }
    ]
    const one = planMissionPlacement(jobs, fleet, request)
    const two = planMissionPlacement(jobs.toReversed(), fleet.toReversed(), request)
    expect(two).toEqual(one)
  })
})

describe('mission job placement: dependent jobs may share a host, independent jobs spread', () => {
  const small = toRuntimeExecutionHostId('small')
  const fleet = [
    member(LOCAL_EXECUTION_HOST_ID, 'fp-win', 24 * GB),
    member(small, 'fp-small', 16 * GB)
  ]
  const mapping = (plan: ReturnType<typeof planMissionPlacement>) =>
    Object.fromEntries(plan.placements.map((p) => [p.jobId, p.fingerprint]))

  it('puts a job on its dependency host and sends the independent job to the other host', () => {
    const plan = planMissionPlacement(
      [{ jobId: 't1' }, { jobId: 't2', dependsOn: ['t1'] }, { jobId: 't3' }],
      fleet,
      request
    )
    expect(mapping(plan)).toEqual({ t1: 'fp-win', t2: 'fp-win', t3: 'fp-small' })
    expect(plan.hostCount).toBe(2)
  })

  it('control: with no dependency information the earlier mapping holds', () => {
    const plan = planMissionPlacement(
      [{ jobId: 't1' }, { jobId: 't2' }, { jobId: 't3' }],
      fleet,
      request
    )
    expect(mapping(plan)).toEqual({ t1: 'fp-win', t2: 'fp-small', t3: 'fp-win' })
  })

  it('keeps independent jobs apart: two differ, and three over two hosts never put all on one', () => {
    const two = planMissionPlacement([{ jobId: 't1' }, { jobId: 't2' }], fleet, request)
    expect(new Set(Object.values(mapping(two))).size).toBe(2)
    const three = planMissionPlacement(
      [{ jobId: 't1' }, { jobId: 't2' }, { jobId: 't3' }],
      fleet,
      request
    )
    const perHost = Object.values(mapping(three)).reduce<Record<string, number>>(
      (counts, fp) => ({ ...counts, [fp]: (counts[fp] ?? 0) + 1 }),
      {}
    )
    expect(Math.max(...Object.values(perHost))).toBeLessThanOrEqual(2)
    expect(Object.keys(perHost)).toHaveLength(2)
  })

  it('shares the only eligible host among independent jobs and leaves none unplaced', () => {
    const plan = planMissionPlacement(
      [{ jobId: 't1' }, { jobId: 't2' }, { jobId: 't3' }],
      [fleet[0]],
      request
    )
    expect(plan.unplaced).toEqual([])
    expect(new Set(Object.values(mapping(plan)))).toEqual(new Set(['fp-win']))
  })

  it('relates a job to every ancestor, not only its direct dependency', () => {
    const plan = planMissionPlacement(
      [
        { jobId: 't1' },
        { jobId: 't2', dependsOn: ['t1'] },
        { jobId: 't3', dependsOn: ['t2'] },
        { jobId: 't4' }
      ],
      fleet,
      request
    )
    expect(mapping(plan)).toEqual({ t1: 'fp-win', t2: 'fp-win', t3: 'fp-win', t4: 'fp-small' })
  })

  it('treats two jobs that only share a dependency as independent', () => {
    const plan = planMissionPlacement(
      [{ jobId: 't1' }, { jobId: 't2', dependsOn: ['t1'] }, { jobId: 't3', dependsOn: ['t1'] }],
      fleet,
      request
    )
    expect(mapping(plan)).toEqual({ t1: 'fp-win', t2: 'fp-win', t3: 'fp-small' })
  })

  it('ignores a dependency on a task outside the call', () => {
    const plan = planMissionPlacement(
      [{ jobId: 't1' }, { jobId: 't2', dependsOn: ['not-in-this-call'] }],
      fleet,
      request
    )
    expect(mapping(plan)).toEqual({ t1: 'fp-win', t2: 'fp-small' })
  })

  it('terminates on a dependency cycle and counts its members as related', () => {
    const plan = planMissionPlacement(
      [{ jobId: 't1', dependsOn: ['t2'] }, { jobId: 't2', dependsOn: ['t1'] }, { jobId: 't3' }],
      fleet,
      request
    )
    expect(mapping(plan)).toEqual({ t1: 'fp-win', t2: 'fp-win', t3: 'fp-small' })
  })

  it('terminates on a job that depends on itself', () => {
    const plan = planMissionPlacement(
      [{ jobId: 't1', dependsOn: ['t1'] }, { jobId: 't2' }],
      fleet,
      request
    )
    expect(mapping(plan)).toEqual({ t1: 'fp-win', t2: 'fp-small' })
  })

  it('gives the identical mapping for every order of the job list and of the member list', () => {
    const jobs: MissionJob[] = [
      { jobId: 't1' },
      { jobId: 't2', dependsOn: ['t1'] },
      { jobId: 't3' },
      { jobId: 't4', dependsOn: ['t3'] }
    ]
    const permutations = <T>(items: readonly T[]): T[][] =>
      items.length <= 1
        ? [[...items]]
        : items.flatMap((item, i) =>
            permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [
              item,
              ...rest
            ])
          )
    const orders = permutations(jobs)
    expect(orders).toHaveLength(24)
    const golden = mapping(planMissionPlacement(jobs, fleet, request))
    expect(golden).toEqual({ t1: 'fp-win', t2: 'fp-win', t3: 'fp-small', t4: 'fp-small' })
    for (const order of orders) {
      for (const members of [fleet, fleet.toReversed()]) {
        expect(mapping(planMissionPlacement(order, members, request))).toEqual(golden)
      }
    }
  })
})
