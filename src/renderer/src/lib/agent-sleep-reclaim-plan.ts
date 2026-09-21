import type { MemorySnapshot, ProcessMemoryMetric } from '../../../shared/process-stats-types'
import type { AgentHibernationCandidate } from './agent-hibernation-planner'
import {
  isSnapshotUsable,
  projectCandidateFootprint,
  summarizeReclaimEstimate,
  type SleepReclaimEstimate,
  type SleepReclaimFootprint
} from './agent-sleep-reclaim-projection'

/**
 * Joins the hibernation planner's candidates to measured resource footprints.
 *
 * The planner remains the only admission authority — nothing here decides
 * whether a candidate may sleep. This only answers "what would it free, and
 * what could we not measure", so the user authorizes a number that is either
 * real or visibly absent.
 */

export type SleepReclaimCandidateEstimate = {
  candidateId: string
  worktreeId: string
  estimate: SleepReclaimEstimate
}

export type SleepReclaimPlan = {
  snapshotUsable: boolean
  metric: ProcessMemoryMetric | null
  candidates: SleepReclaimCandidateEstimate[]
  /** Built from the deduped union of every candidate's panes, so a pane two
   *  candidates both claim is counted once. */
  total: SleepReclaimEstimate
}

export function projectSleepReclaimPlan(
  candidates: readonly AgentHibernationCandidate[],
  snapshot: MemorySnapshot | null | undefined
): SleepReclaimPlan {
  // Why: the empty fallback snapshot still carries a real metric; only a wholly
  // absent snapshot leaves the unit unknowable.
  const metric = snapshot?.processMemoryMetric ?? null

  const perCandidate = candidates.map((candidate) => ({
    candidateId: candidate.id,
    worktreeId: candidate.worktreeId,
    estimate: summarizeReclaimEstimate(
      panesOf(candidate).map((paneKey) => projectCandidateFootprint(paneKey, snapshot)),
      metric
    )
  }))

  const seen = new Set<string>()
  const distinctFootprints: SleepReclaimFootprint[] = []
  for (const candidate of candidates) {
    for (const paneKey of panesOf(candidate)) {
      if (!seen.has(paneKey)) {
        seen.add(paneKey)
        distinctFootprints.push(projectCandidateFootprint(paneKey, snapshot))
      }
    }
  }

  return {
    snapshotUsable: isSnapshotUsable(snapshot),
    metric,
    candidates: perCandidate,
    total: summarizeReclaimEstimate(distinctFootprints, metric)
  }
}

/** A candidate may cover a group; paneKeys is the authority and paneKey its anchor. */
function panesOf(candidate: AgentHibernationCandidate): string[] {
  return candidate.paneKeys.length > 0 ? candidate.paneKeys : [candidate.paneKey]
}
