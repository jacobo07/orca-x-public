import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import type {
  ParkPhaseResult,
  ParkRequest,
  ParkWorkspaceOutcome
} from '../../../../shared/durable-exit-types'
import { getPinnedTerminalTabIds } from '../agent-hibernation-planner-snapshot'
import { getAllDrivers } from '../pane-manager/mobile-driver-state'
import { mergePendingTerminalInputActivity } from '../terminal-input-activity-coalescing'
import { buildWorkspaceSessionPayload, shouldPersistWorkspaceSession } from '../workspace-session'
import { buildWorkspaceSessionHostSnapshots } from '../workspace-session-host-persistence'
import {
  childProcessAnswerFor,
  collectParkSubjectPtyIds,
  planParkWorkspaces,
  tabLivePtyIds,
  type ChildProcessAnswer,
  type ParkPlanSnapshot,
  type ParkWorkspacePlan
} from './park-workspace-plan'

export type ParkPhaseDeps = {
  getState: () => AppState
  inspectChildren: (ptyId: string) => Promise<ChildProcessAnswer>
  sleepWorkspace: (worktreeId: string) => Promise<void>
  saveSession: () => Promise<void>
}

function parkSnapshot(state: AppState): ParkPlanSnapshot {
  return {
    tabsByWorktree: state.tabsByWorktree,
    terminalLayoutsByTabId: state.terminalLayoutsByTabId,
    ptyIdsByTabId: state.ptyIdsByTabId,
    mobileLockedPtyIds: [...getAllDrivers()]
      .filter(([, driver]) => driver.kind === 'mobile')
      .map(([ptyId]) => ptyId),
    pinnedTerminalTabIds: getPinnedTerminalTabIds(state),
    agentStatusByPaneKey: state.agentStatusByPaneKey,
    // Why: input stamps are coalesced; a keystroke not yet flushed is still a draft.
    lastTerminalInputAtByPaneKey: mergePendingTerminalInputActivity(
      state.lastTerminalInputAtByPaneKey
    )
  }
}

async function planNow(
  deps: ParkPhaseDeps,
  request: ParkRequest,
  worktreeId?: string
): Promise<ParkWorkspacePlan[]> {
  const snapshot = parkSnapshot(deps.getState())
  const ptyIds = Object.entries(snapshot.tabsByWorktree)
    .filter(([id]) => worktreeId === undefined || id === worktreeId)
    .flatMap(([, tabs]) => tabs.flatMap((tab) => tabLivePtyIds(snapshot, tab)))
  const answers = await Promise.all(
    ptyIds.map(async (ptyId) => [ptyId, await deps.inspectChildren(ptyId)] as const)
  )
  // Why: the probes awaited; judge the state as it is now, with those answers.
  const plans = planParkWorkspaces(parkSnapshot(deps.getState()), Object.fromEntries(answers), {
    includePinned: request.includePinned
  })
  return worktreeId === undefined ? plans : plans.filter((plan) => plan.worktreeId === worktreeId)
}

function workspaceAsleep(state: AppState, worktreeId: string): string[] | null {
  const tabs = state.tabsByWorktree[worktreeId] ?? []
  const asleep = tabs.every(
    (tab) => tab.dormancy !== undefined && tabLivePtyIds(state, tab).length === 0
  )
  return asleep ? tabs.map((tab) => tab.id) : null
}

/**
 * The renderer half of a park: plan, refuse or seal, release each workspace through workspace Sleep,
 * seal again. See docs/reference/durable-park-and-exit.md. Never kills anything itself.
 */
export async function runParkPhase(
  request: ParkRequest,
  deps: ParkPhaseDeps
): Promise<ParkPhaseResult> {
  const state = deps.getState()
  const alreadyAsleepCount = Object.values(state.tabsByWorktree).filter(
    (tabs) => tabs.length > 0 && tabs.every((tab) => tabLivePtyIds(state, tab).length === 0)
  ).length
  const plans = await planNow(deps, request)
  const planned: ParkWorkspaceOutcome[] = plans.map((plan) =>
    plan.keepReasons.length > 0
      ? {
          worktreeId: plan.worktreeId,
          outcome: 'kept',
          reasons: plan.keepReasons,
          livePtyCount: plan.livePtyIds.length
        }
      : {
          worktreeId: plan.worktreeId,
          outcome: 'would-sleep',
          livePtyCount: plan.livePtyIds.length
        }
  )
  const base = { alreadyAsleepCount, sleptTabIds: [] as string[] }
  if (request.mode === 'plan') {
    return { ...base, status: 'planned', workspaces: planned }
  }
  if (planned.some((workspace) => workspace.outcome === 'kept')) {
    return { ...base, status: 'refused', workspaces: planned }
  }
  if (!shouldPersistWorkspaceSession(deps.getState())) {
    return { ...base, status: 'seal-failed', workspaces: planned, detail: 'session-not-ready' }
  }
  try {
    await deps.saveSession()
  } catch (error) {
    return { ...base, status: 'seal-failed', workspaces: planned, detail: String(error) }
  }
  if (plans.length === 0) {
    return { ...base, status: 'nothing-to-park', workspaces: [] }
  }

  const outcomes: ParkWorkspaceOutcome[] = []
  const sleptTabIds: string[] = []
  for (const plan of plans) {
    // Why: the approved set only shrinks; each member is judged again right before its own sleep.
    const fresh = (await planNow(deps, request, plan.worktreeId))[0]
    if (!fresh) {
      const tabIds = workspaceAsleep(deps.getState(), plan.worktreeId)
      if (tabIds) {
        sleptTabIds.push(...tabIds)
      }
      outcomes.push({ worktreeId: plan.worktreeId, outcome: 'slept', livePtyCount: 0 })
      continue
    }
    if (fresh.keepReasons.length > 0) {
      outcomes.push({ worktreeId: plan.worktreeId, outcome: 'changed', reasons: fresh.keepReasons })
      continue
    }
    try {
      await deps.sleepWorkspace(plan.worktreeId)
    } catch (error) {
      outcomes.push({ worktreeId: plan.worktreeId, outcome: 'failed', detail: String(error) })
      continue
    }
    const tabIds = workspaceAsleep(deps.getState(), plan.worktreeId)
    if (!tabIds) {
      outcomes.push({ worktreeId: plan.worktreeId, outcome: 'failed', detail: 'still-running' })
      continue
    }
    sleptTabIds.push(...tabIds)
    outcomes.push({
      worktreeId: plan.worktreeId,
      outcome: 'slept',
      livePtyCount: fresh.livePtyIds.length
    })
  }

  // Why: a terminal started elsewhere during the run is not ours to sleep, and it is still running.
  const judged = new Set(plans.map((plan) => plan.worktreeId))
  for (const worktreeId of collectParkSubjectPtyIds(parkSnapshot(deps.getState())).keys()) {
    if (!judged.has(worktreeId)) {
      outcomes.push({ worktreeId, outcome: 'changed', reasons: [] })
    }
  }

  try {
    await deps.saveSession()
  } catch (error) {
    return {
      alreadyAsleepCount,
      sleptTabIds,
      status: 'seal-failed',
      workspaces: outcomes,
      detail: String(error)
    }
  }
  const complete = outcomes.every((workspace) => workspace.outcome === 'slept')
  return {
    alreadyAsleepCount,
    sleptTabIds,
    status: complete ? 'parked' : 'incomplete',
    workspaces: outcomes
  }
}

async function saveWorkspaceSessionNow(): Promise<void> {
  useAppStore.getState().captureAllSleepingAgentSessions('periodic')
  const state = useAppStore.getState()
  for (const snapshot of buildWorkspaceSessionHostSnapshots(
    buildWorkspaceSessionPayload(state),
    state
  )) {
    await window.api.session.set(snapshot.state, snapshot.hostId)
  }
  await window.api.session.flush()
}

async function inspectChildren(ptyId: string): Promise<ChildProcessAnswer> {
  try {
    return childProcessAnswerFor(await window.api.pty.inspectProcess(ptyId))
  } catch {
    return 'unknown'
  }
}

export function createParkPhaseDeps(
  sleepWorkspace: (worktreeId: string) => Promise<void>
): ParkPhaseDeps {
  return {
    getState: () => useAppStore.getState(),
    inspectChildren,
    sleepWorkspace,
    saveSession: saveWorkspaceSessionNow
  }
}
