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
  runtimeHostPtyIdByRuntimeIdByWorktreeId: Record<string, Record<string, string>>
  runtimeLivenessRequiredWorktreeIds: string[]
  runtimeEnvironmentIdByWorktreeId: Record<string, string>
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

/** What a runtime answered, stamped with the host each worktree was asked on. */
export type SampledRuntimePtyLiveness = {
  /** Live identities as panes name them: host PTY ids and terminal handles. */
  runtimeLivePtyIdsByWorktreeId: Record<string, string[]>
  /** The host PTY each live identity resolves to — what exact stop targets. */
  hostPtyIdByRuntimeIdByWorktreeId: Record<string, Record<string, string>>
  environmentIdByWorktreeId: Record<string, string>
}

/**
 * Applies a sample to current state. Every current runtime worktree requires
 * liveness; only those answered by the host they still belong to supply it, so
 * a missing, late or re-homed answer reads as `runtime-liveness-unknown`.
 */
export function fenceRuntimePtyLivenessSample(
  state: AppState,
  sample: SampledRuntimePtyLiveness | null
): RuntimePtyLivenessSample {
  const targets = getRuntimeLivenessTargetWorktrees(state)
  const runtimeLivePtyIdsByWorktreeId: Record<string, string[]> = {}
  const runtimeHostPtyIdByRuntimeIdByWorktreeId: Record<string, Record<string, string>> = {}
  for (const [worktreeId, environmentId] of targets) {
    if (
      sample &&
      Object.hasOwn(sample.runtimeLivePtyIdsByWorktreeId, worktreeId) &&
      sample.environmentIdByWorktreeId[worktreeId] === environmentId
    ) {
      runtimeLivePtyIdsByWorktreeId[worktreeId] = sample.runtimeLivePtyIdsByWorktreeId[worktreeId]
      runtimeHostPtyIdByRuntimeIdByWorktreeId[worktreeId] =
        sample.hostPtyIdByRuntimeIdByWorktreeId[worktreeId] ?? {}
    }
  }
  return {
    runtimeLivePtyIdsByWorktreeId,
    runtimeHostPtyIdByRuntimeIdByWorktreeId,
    runtimeLivenessRequiredWorktreeIds: [...targets.keys()],
    runtimeEnvironmentIdByWorktreeId: Object.fromEntries(targets)
  }
}

/** For callers holding no sample: every runtime worktree fails closed. */
export function unsampledRuntimePtyLiveness(state: AppState): RuntimePtyLivenessSample {
  return fenceRuntimePtyLivenessSample(state, null)
}

/**
 * A terminal tab counts as pinned if either copy of the pin says so — the same
 * rule the host close path applies — so a lagging mirror cannot un-pin it here.
 */
export function getPinnedTerminalTabIds(state: AppState): string[] {
  const pinned = new Set<string>()
  for (const tabs of Object.values(state.tabsByWorktree)) {
    for (const tab of tabs ?? []) {
      if (tab.isPinned === true) {
        pinned.add(tab.id)
      }
    }
  }
  for (const tabs of Object.values(state.unifiedTabsByWorktree ?? {})) {
    for (const tab of tabs ?? []) {
      if (tab.contentType === 'terminal' && tab.isPinned === true) {
        pinned.add(tab.entityId)
      }
    }
  }
  return [...pinned].sort()
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
    runtimeEnvironmentIdByWorktreeId: runtimeLiveness.runtimeEnvironmentIdByWorktreeId,
    runtimeHostPtyIdByRuntimeIdByWorktreeId:
      runtimeLiveness.runtimeHostPtyIdByRuntimeIdByWorktreeId,
    mobileLockedPtyIds: [...getAllDrivers()]
      .filter(([, driver]) => driver.kind === 'mobile')
      .map(([ptyId]) => ptyId),
    pinnedTerminalTabIds: getPinnedTerminalTabIds(state),
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
