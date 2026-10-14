import { describe, expect, it } from 'vitest'
import { LOCAL_EXECUTION_HOST_ID, toRuntimeExecutionHostId, type ExecutionHostId } from './execution-host'
import type { FleetPlacementMember } from './fleet-placement'
import { integrateMissionResults, planMissionPlacement } from './mission-job-placement'

const GB = 1024 ** 3
const NOW = 1_000_000
const request = { now: NOW, maxSampleAgeMs: 60_000 }

function member(address: ExecutionHostId, fp: string | null, avail: number | null): FleetPlacementMember {
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
    facts: { runtimeId: `rt-${address}`, platform: 'linux', capabilities: ['code'], protocol: 'compatible' }
  }
}
const gex = toRuntimeExecutionHostId('gex44')

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
    const plan = planMissionPlacement([{ jobId: 'a' }, { jobId: 'b' }, { jobId: 'c' }], fleet, request)
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
    const plan = planMissionPlacement([{ jobId: 'a', requiredCapabilities: ['gpu'] }], fleet, request)
    expect(plan.placements).toEqual([])
    expect(plan.unplaced).toEqual([{ jobId: 'a', reason: 'no-eligible-host' }])
  })

  it('integrates results per host and reports cross-host only when two hosts completed', () => {
    const plan = planMissionPlacement([{ jobId: 'a' }, { jobId: 'b' }], fleet, request)
    const partial = integrateMissionResults(plan.placements, [{ jobId: 'a', status: 'completed', result: 'ok' }])
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
