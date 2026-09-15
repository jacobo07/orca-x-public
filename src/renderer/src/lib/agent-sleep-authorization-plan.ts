import type { MemorySnapshot, ProcessMemoryMetric } from '../../../shared/process-stats-types'
import {
  getResourceMemoryMetricCopy,
  type ResourceMemoryMetricCopy
} from '../components/status-bar/resource-memory-metric-copy'
import {
  classifyAgentHibernationPanes,
  planAgentHibernationCandidates,
  type AgentHibernationExclusionReason,
  type AgentHibernationPlannerSnapshot
} from './agent-hibernation-planner'
import { projectSleepReclaimPlan } from './agent-sleep-reclaim-plan'
import {
  projectCandidateFootprint,
  type SleepReclaimEstimate,
  type SleepReclaimFootprint
} from './agent-sleep-reclaim-projection'

/**
 * What the user is asked to authorize, before anything is destroyed.
 *
 * Observational by construction: it composes the planner's eligibility verdicts
 * with the meter's footprints and decides nothing. A plan is evidence of intent,
 * never kill authority — the execution boundary re-authorizes against live state.
 */

export type SleepAuthorizationSubject = {
  paneKey: string
  worktreeId: string
  tabId: string
  /** null exactly when the subject is reclaimable. */
  exclusionReason: AgentHibernationExclusionReason | null
  /** Shown for every subject; only reclaimable ones reach the estimate. */
  footprint: SleepReclaimFootprint
}

export type SleepAuthorizationPlan = {
  metric: ProcessMemoryMetric | null
  /** null when the unit is unknowable — the copy owner cannot describe an absent metric. */
  metricCopy: ResourceMemoryMetricCopy | null
  snapshotUsable: boolean
  reclaimable: SleepAuthorizationSubject[]
  excluded: SleepAuthorizationSubject[]
  /** Deduped, over reclaimable panes only. Unknowns stay counted, never summed as zero. */
  estimate: SleepReclaimEstimate
}

export function buildSleepAuthorizationPlan(
  plannerSnapshot: AgentHibernationPlannerSnapshot,
  memory: MemorySnapshot | null | undefined
): SleepAuthorizationPlan {
  const classifications = classifyAgentHibernationPanes(plannerSnapshot)
  // Why: both come from the planner's one walk, so the reclaimable set here and
  // the set execution will act on cannot disagree.
  const reclaim = projectSleepReclaimPlan(planAgentHibernationCandidates(plannerSnapshot), memory)

  const reclaimable: SleepAuthorizationSubject[] = []
  const excluded: SleepAuthorizationSubject[] = []
  for (const pane of classifications) {
    const subject: SleepAuthorizationSubject = {
      paneKey: pane.paneKey,
      worktreeId: pane.worktreeId,
      tabId: pane.tabId,
      exclusionReason: pane.reason,
      footprint: projectCandidateFootprint(pane.paneKey, memory)
    }
    if (pane.eligible) {
      reclaimable.push(subject)
    } else {
      excluded.push(subject)
    }
  }

  return {
    metric: reclaim.metric,
    metricCopy: reclaim.metric ? getResourceMemoryMetricCopy(reclaim.metric) : null,
    snapshotUsable: reclaim.snapshotUsable,
    reclaimable,
    excluded,
    estimate: reclaim.total
  }
}
