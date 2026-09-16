import { useAppStore } from '@/store'
import {
  buildAgentHibernationPlannerSnapshot,
  unsampledRuntimePtyLiveness
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
export function observeSleepAuthorizationPlan(now: number = Date.now()): SleepAuthorizationPlan {
  const state = useAppStore.getState()
  return buildSleepAuthorizationPlan(
    // Why unsampled: a render must not fire the coordinator's RPC liveness sweep,
    // so runtime-backed worktrees fail closed rather than display a stale verdict.
    buildAgentHibernationPlannerSnapshot(state, now, unsampledRuntimePtyLiveness(state)),
    state.memorySnapshot
  )
}
