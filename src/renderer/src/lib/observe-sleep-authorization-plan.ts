import { useAppStore } from '@/store'
import {
  buildAgentHibernationPlannerSnapshot,
  fenceRuntimePtyLivenessSample,
  type SampledRuntimePtyLiveness
} from './agent-hibernation-planner-snapshot'
import {
  buildSleepAuthorizationPlan,
  type SleepAuthorizationPlan
} from './agent-sleep-authorization-plan'

/**
 * Reads the current store into an authorization plan for display.
 *
 * The only glue between the store and the canonical plan: it decides nothing,
 * so deleting the surface that calls it cannot change what may be reclaimed.
 *
 * Observation-time by construction. What it returns is evidence of what current
 * state says, never permission to destroy anything later — the coordinator
 * re-authorizes against live state at the moment of effect.
 */
export function observeSleepAuthorizationPlan(
  runtimeLiveness: SampledRuntimePtyLiveness | null = null,
  now: number = Date.now()
): SleepAuthorizationPlan {
  const state = useAppStore.getState()
  return buildSleepAuthorizationPlan(
    // Why: a render never samples; it applies the caller's last sample, and a
    // runtime worktree that sample did not answer stays unknown.
    buildAgentHibernationPlannerSnapshot(
      state,
      now,
      fenceRuntimePtyLivenessSample(state, runtimeLiveness)
    ),
    state.memorySnapshot
  )
}
