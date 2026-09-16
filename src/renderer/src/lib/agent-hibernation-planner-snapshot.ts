import type { AppState } from '@/store/types'
import type { AgentHibernationPlannerSnapshot } from './agent-hibernation-planner'
import { getAllDrivers } from './pane-manager/mobile-driver-state'
import {
  getForegroundTerminalTabIds,
  getForegroundTerminalTabLastSeenAtById
} from './foreground-terminal-tabs'
import { mergePendingTerminalInputActivity } from './terminal-input-activity-coalescing'
import { getRuntimeEnvironmentIdForWorktree } from './worktree-runtime-owner'

/**
 * The one way to read store state into a planner snapshot.
 *
 * Shared rather than copied: the surface that shows a user what may be reclaimed
 * and the coordinator that destroys it must walk the same inputs, or the set
 * displayed and the set executed can disagree without anything going red.
 */

export type RuntimePtyLivenessSample = {
  runtimeLivePtyIdsByWorktreeId: Record<string, string[]>
  runtimeLivenessRequiredWorktreeIds: string[]
}

export function getRuntimeLivenessTargetWorktrees(state: AppState): Map<string, string> {
  const targets = new Map<string, string>()
  for (const worktreeId of Object.keys(state.tabsByWorktree)) {
    const runtimeEnvironmentId = getRuntimeEnvironmentIdForWorktree(state, worktreeId)
    if (runtimeEnvironmentId) {
      targets.set(worktreeId, runtimeEnvironmentId)
    }
  }
  return targets
}

/**
 * For observational callers that must not fire an RPC sweep: name every worktree
 * that requires liveness while supplying none, so the planner fails closed into
 * `runtime-liveness-unknown` instead of falling back to possibly-stale pty ids.
 */
export function unsampledRuntimePtyLiveness(state: AppState): RuntimePtyLivenessSample {
  return {
    runtimeLivePtyIdsByWorktreeId: {},
    runtimeLivenessRequiredWorktreeIds: [...getRuntimeLivenessTargetWorktrees(state).keys()]
  }
}

export function buildAgentHibernationPlannerSnapshot(
  state: AppState,
  now: number,
  runtimeLiveness: RuntimePtyLivenessSample
): AgentHibernationPlannerSnapshot {
  return {
    settings: state.settings,
    activeWorktreeId: state.activeWorktreeId,
    foregroundTerminalTabIds: getForegroundTerminalTabIds(),
    tabsByWorktree: state.tabsByWorktree,
    terminalLayoutsByTabId: state.terminalLayoutsByTabId,
    ptyIdsByTabId: state.ptyIdsByTabId,
    runtimeLivePtyIdsByWorktreeId: runtimeLiveness.runtimeLivePtyIdsByWorktreeId,
    runtimeLivenessRequiredWorktreeIds: runtimeLiveness.runtimeLivenessRequiredWorktreeIds,
    mobileLockedPtyIds: [...getAllDrivers()]
      .filter(([, driver]) => driver.kind === 'mobile')
      .map(([ptyId]) => ptyId),
    agentStatusByPaneKey: state.agentStatusByPaneKey,
    sleepingAgentSessionsByPaneKey: state.sleepingAgentSessionsByPaneKey,
    // Why: input stamps are coalesced, so planning must see the not-yet-flushed keystroke.
    lastTerminalInputAtByPaneKey: mergePendingTerminalInputActivity(
      state.lastTerminalInputAtByPaneKey
    ),
    foregroundTerminalLastSeenAtByTabId: getForegroundTerminalTabLastSeenAtById(),
    now
  }
}
