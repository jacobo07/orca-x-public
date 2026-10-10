import {
  planFleetPlacement,
  type FleetPlacementMember,
  type FleetPlacementRejected,
  type FleetPlacementRequest
} from './fleet-placement'
import type { ExecutionHostId } from './execution-host'

export type MissionJob = { jobId: string; requiredCapabilities?: readonly string[] }

export type MissionJobPlacement = {
  jobId: string
  /** Host identity (fingerprint) the job is placed on. */
  fingerprint: string
  hostKey: string
  /** Address the dispatch path must re-resolve before acting; this alone authorizes nothing. */
  address: ExecutionHostId
  label: string
}

export type MissionPlacementPlan = {
  placements: MissionJobPlacement[]
  unplaced: { jobId: string; reason: 'no-eligible-host' }[]
  rejected: FleetPlacementRejected[]
  /** Distinct hosts the plan runs jobs on. */
  hostCount: number
}

/**
 * Spreads the jobs of ONE mission over distinct eligible hosts, so they can run concurrently on
 * separate machines. Every job is judged by planFleetPlacement per its own capability need; a host
 * already holding a job of this mission is used again only when no unused eligible host remains.
 * Deterministic for any input order. A plan authorizes nothing: dispatch re-resolves identity.
 */
export function planMissionPlacement(
  jobs: readonly MissionJob[],
  members: readonly FleetPlacementMember[],
  request: FleetPlacementRequest
): MissionPlacementPlan {
  const load = new Map<string, number>()
  const placements: MissionJobPlacement[] = []
  const unplaced: MissionPlacementPlan['unplaced'] = []
  let rejected: FleetPlacementRejected[] = []
  const ordered = [...jobs].sort((a, b) => (a.jobId < b.jobId ? -1 : a.jobId > b.jobId ? 1 : 0))
  for (const job of ordered) {
    const proposal = planFleetPlacement(members, {
      ...request,
      requiredCapabilities: [
        ...(request.requiredCapabilities ?? []),
        ...(job.requiredCapabilities ?? [])
      ]
    })
    rejected = proposal.rejected
    if (proposal.eligible.length === 0) {
      unplaced.push({ jobId: job.jobId, reason: 'no-eligible-host' })
      continue
    }
    // Stable sort: the fleet ranking (most memory first) breaks ties between equally loaded hosts.
    const pick = [...proposal.eligible].sort(
      (a, b) => (load.get(a.key) ?? 0) - (load.get(b.key) ?? 0)
    )[0]
    load.set(pick.key, (load.get(pick.key) ?? 0) + 1)
    placements.push({
      jobId: job.jobId,
      fingerprint: pick.fingerprint,
      hostKey: pick.key,
      address: pick.evidenceAddress,
      label: pick.label
    })
  }
  return { placements, unplaced, rejected, hostCount: load.size }
}

export type MissionJobOutcome = { jobId: string; status: 'completed' | 'failed'; result?: string }

export type IntegratedMissionResults = {
  byHost: { hostKey: string; label: string; jobs: { jobId: string; status: string; result?: string }[] }[]
  completed: number
  failed: number
  /** Placed jobs with no outcome yet; the integration is not complete while any remain. */
  pending: string[]
  /** True only when jobs of this mission completed on two or more distinct hosts. */
  crossHost: boolean
}

export function integrateMissionResults(
  placements: readonly MissionJobPlacement[],
  outcomes: readonly MissionJobOutcome[]
): IntegratedMissionResults {
  const outcomeOf = new Map(outcomes.map((o) => [o.jobId, o]))
  const hosts = new Map<string, IntegratedMissionResults['byHost'][number]>()
  const pending: string[] = []
  let completed = 0
  let failed = 0
  const completedHosts = new Set<string>()
  for (const p of placements) {
    const entry = hosts.get(p.hostKey) ?? { hostKey: p.hostKey, label: p.label, jobs: [] }
    hosts.set(p.hostKey, entry)
    const o = outcomeOf.get(p.jobId)
    if (!o) {
      pending.push(p.jobId)
      continue
    }
    entry.jobs.push({ jobId: p.jobId, status: o.status, result: o.result })
    if (o.status === 'completed') {
      completed++
      completedHosts.add(p.hostKey)
    } else {
      failed++
    }
  }
  return {
    byHost: [...hosts.values()].sort((a, b) => (a.hostKey < b.hostKey ? -1 : 1)),
    completed,
    failed,
    pending: pending.sort(),
    crossHost: completedHosts.size >= 2
  }
}
