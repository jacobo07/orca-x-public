import {
  planFleetPlacement,
  type FleetPlacementMember,
  type FleetPlacementRejected,
  type FleetPlacementRequest
} from './fleet-placement'
import type { ExecutionHostId } from './execution-host'
import type { NodeRequirement } from './node-manifest-eligibility'
import { rankMissionCandidates } from './placement-host-ranking'

export type MissionJob = {
  jobId: string
  requiredCapabilities?: readonly string[]
  /** A family set here replaces that family of the request requirement; unset families are inherited. */
  requirement?: NodeRequirement
  /** Hosts that hold the job's project; a ranking term over already eligible hosts, never eligibility. */
  hydratedAddresses?: readonly ExecutionHostId[]
  /** Ids of the tasks this job waits on; only ids that are jobs of the same call matter. */
  dependsOn?: readonly string[]
}

export type MissionJobPlacement = {
  jobId: string
  /** Host identity (fingerprint) the job is placed on. */
  fingerprint: string
  hostKey: string
  /** Address the dispatch path must re-resolve before acting; this alone authorizes nothing. */
  address: ExecutionHostId
  label: string
  /** True when the chosen host held the job's project; absent on placements built elsewhere. */
  hydrated?: boolean
}

export type MissionPlacementPlan = {
  placements: MissionJobPlacement[]
  unplaced: { jobId: string; reason: 'no-eligible-host' }[]
  /** The last judged job's rejections; kept as it was before per-job detail existed. */
  rejected: FleetPlacementRejected[]
  /** Every judged job's own rejections, placed or not, in job order. */
  rejectedByJob: { jobId: string; rejected: FleetPlacementRejected[] }[]
  /** Distinct hosts the plan runs jobs on. */
  hostCount: number
}

// Why: an explicitly undefined family on the job must not erase the inherited one.
function mergeJobRequirement(
  base: NodeRequirement | undefined,
  job: NodeRequirement | undefined
): NodeRequirement | undefined {
  if (!job) {
    return base
  }
  const set = Object.entries(job).filter(([, family]) => family !== undefined)
  return { ...base, ...Object.fromEntries(set) }
}

// Why: two jobs on a dependency path cannot run at once, so they never count against each other's host.
function relatedJobPairs(jobs: readonly MissionJob[]): (a: string, b: string) => boolean {
  const inCall = new Set(jobs.map((job) => job.jobId))
  const direct = new Map(
    jobs.map((job) => [job.jobId, (job.dependsOn ?? []).filter((id) => inCall.has(id))])
  )
  const reachable = new Map<string, Set<string>>()
  // Why: the seen set is what makes a dependency cycle terminate.
  const collect = (id: string, seen: Set<string>): void => {
    for (const next of direct.get(id) ?? []) {
      if (!seen.has(next)) {
        seen.add(next)
        collect(next, seen)
      }
    }
  }
  for (const job of jobs) {
    const seen = new Set<string>()
    collect(job.jobId, seen)
    reachable.set(job.jobId, seen)
  }
  return (a, b) => reachable.get(a)?.has(b) === true || reachable.get(b)?.has(a) === true
}

/**
 * Spreads the jobs of ONE mission over distinct eligible hosts, so they can run concurrently on
 * separate machines. Every job is judged by planFleetPlacement per its own capability need; a host
 * already holding an unrelated job of this mission is used again only when no unused eligible host
 * remains, while a job may share a host with a job it depends on, or that depends on it.
 * Deterministic for any input order. A plan authorizes nothing: dispatch re-resolves identity.
 */
export function planMissionPlacement(
  jobs: readonly MissionJob[],
  members: readonly FleetPlacementMember[],
  request: FleetPlacementRequest
): MissionPlacementPlan {
  const hostsUsed = new Set<string>()
  const placedOn = new Map<string, string[]>()
  const related = relatedJobPairs(jobs)
  const placements: MissionJobPlacement[] = []
  const unplaced: MissionPlacementPlan['unplaced'] = []
  let rejected: FleetPlacementRejected[] = []
  const rejectedByJob: MissionPlacementPlan['rejectedByJob'] = []
  const ordered = [...jobs].sort((a, b) => (a.jobId < b.jobId ? -1 : a.jobId > b.jobId ? 1 : 0))
  for (const job of ordered) {
    const requirement = mergeJobRequirement(request.requirement, job.requirement)
    const proposal = planFleetPlacement(members, {
      ...request,
      ...(requirement ? { requirement } : {}),
      requiredCapabilities: [
        ...(request.requiredCapabilities ?? []),
        ...(job.requiredCapabilities ?? [])
      ]
    })
    rejected = proposal.rejected
    rejectedByJob.push({ jobId: job.jobId, rejected: proposal.rejected })
    if (proposal.eligible.length === 0) {
      unplaced.push({ jobId: job.jobId, reason: 'no-eligible-host' })
      continue
    }
    const hydratedHosts = new Set<string>(job.hydratedAddresses ?? [])
    const isHydrated = (c: { addresses: readonly string[] }) =>
      c.addresses.some((address) => hydratedHosts.has(address))
    const pick = rankMissionCandidates(proposal.eligible, {
      isHydrated,
      loadOf: (c) =>
        (placedOn.get(c.key) ?? []).filter((other) => !related(job.jobId, other)).length
    })[0]
    hostsUsed.add(pick.key)
    placedOn.set(pick.key, [...(placedOn.get(pick.key) ?? []), job.jobId])
    placements.push({
      jobId: job.jobId,
      fingerprint: pick.fingerprint,
      hostKey: pick.key,
      address: pick.evidenceAddress,
      label: pick.label,
      hydrated: isHydrated(pick)
    })
  }
  return { placements, unplaced, rejected, rejectedByJob, hostCount: hostsUsed.size }
}

export type MissionJobOutcome = { jobId: string; status: 'completed' | 'failed'; result?: string }

export type IntegratedMissionResults = {
  byHost: {
    hostKey: string
    label: string
    jobs: { jobId: string; status: string; result?: string }[]
  }[]
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
