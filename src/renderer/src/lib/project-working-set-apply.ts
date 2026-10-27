import type { StoreApi } from 'zustand'
import type { AppState } from '@/store/types'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { resolveDormantResumeContinuity } from '../../../shared/dormant-resume-continuity'
import type {
  RestorePlanBlocker,
  RestorePlanEntry,
  WorkingSetRestorePlan
} from '../../../shared/project-working-set-restore-plan'
import { makePaneKey } from '../../../shared/stable-pane-id'
import type { Tab, TabGroup, TabGroupLayoutNode } from '../../../shared/tab-types'
import {
  terminalTabDormancy,
  type TerminalLayoutSnapshot,
  type TerminalPaneLayoutNode,
  type TerminalTab
} from '../../../shared/terminal-tab-types'
import {
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from '../../../shared/tui-agent-launch-defaults'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { buildWorkspaceSessionPayload } from './workspace-session'

/**
 * Applies a restore plan's composition to one empty workspace, and nothing else.
 *
 * No PTY is spawned and the workspace is not activated. Rows arrive with no process; a pane whose
 * sealed provider session should come back gets a lazy sleeping record, so the pane's own cold
 * restore resumes it when the tab is opened — the same handle a manual workspace sleep leaves.
 *
 * The replacement goes through the store's workspace-scoped hydration (the direct-SSH snapshot
 * path), synchronously, and is rolled back from the prior payload if either half throws or the
 * result is not what was planned.
 */

export type WorkingSetApplyResult =
  | {
      status: 'applied'
      workingSetId: string
      ownerKey: string
      targetTabIds: string[]
      /** Panes that will try their sealed provider session when opened. */
      resumeOnOpen: number
    }
  /** The workspace already holds exactly this working set's panes: a retry, not a second copy. */
  | { status: 'already-applied'; workingSetId: string }
  | { status: 'refused'; blockers: RestorePlanBlocker[] }
  /** Tabs appeared after the plan was made; nothing was changed. */
  | { status: 'target-changed' }
  | { status: 'failed'; stage: 'hydrate' | 'verify'; detail: string; rolledBack: boolean }

export type WorkingSetApplyDeps = {
  store: Pick<StoreApi<AppState>, 'getState'>
  now: () => number
  newId: () => string
}

export function countWorkspaceOpenTabs(state: AppState, ownerKey: string): number {
  return (
    (state.tabsByWorktree[ownerKey]?.length ?? 0) +
    (state.unifiedTabsByWorktree[ownerKey]?.length ?? 0)
  )
}

function leafIds(node: TerminalPaneLayoutNode | null | undefined, into: string[] = []): string[] {
  if (node?.type === 'leaf') {
    into.push(node.leafId)
  } else if (node) {
    leafIds(node.first, into)
    leafIds(node.second, into)
  }
  return into
}

function planFingerprint(plan: WorkingSetRestorePlan): string {
  return plan.entries
    .flatMap((entry) => entry.panes.map((pane) => pane.leafId))
    .sort()
    .join('\n')
}

function workspaceFingerprint(state: AppState, ownerKey: string): string {
  return (state.tabsByWorktree[ownerKey] ?? [])
    .flatMap((tab) => leafIds(state.terminalLayoutsByTabId[tab.id]?.root))
    .sort()
    .join('\n')
}

/** Split geometry is not sealed, so a split tab comes back evenly divided. */
function evenChain<T, N>(
  items: readonly T[],
  leaf: (item: T) => N,
  split: (first: N, second: N, ratio: number) => N
): N {
  const [head, ...rest] = items
  return rest.length === 0
    ? leaf(head)
    : split(leaf(head), evenChain(rest, leaf, split), 1 / items.length)
}

function paneLayout(entry: RestorePlanEntry): TerminalLayoutSnapshot {
  const titlesByLeafId = Object.fromEntries(
    entry.panes.flatMap((pane) => (pane.title ? [[pane.leafId, pane.title]] : []))
  )
  return {
    root: evenChain<RestorePlanEntry['panes'][number], TerminalPaneLayoutNode>(
      entry.panes,
      (pane) => ({ type: 'leaf', leafId: pane.leafId }),
      (first, second, ratio) => ({ type: 'split', direction: 'vertical', first, second, ratio })
    ),
    activeLeafId: entry.activeLeafId,
    expandedLeafId: null,
    ...(Object.keys(titlesByLeafId).length > 0 ? { titlesByLeafId } : {})
  }
}

function sleepingRecords(
  state: AppState,
  ownerKey: string,
  entry: RestorePlanEntry,
  now: number
): [string, SleepingAgentSessionRecord][] {
  return entry.panes.flatMap((pane): [string, SleepingAgentSessionRecord][] => {
    const { resume } = pane
    if (
      !pane.resumeOnOpen ||
      resume.kind !== 'provider-session' ||
      pane.blockers.includes('live-elsewhere')
    ) {
      return []
    }
    const paneKey = makePaneKey(entry.targetTabId, pane.leafId)
    // Why a launch config only for omp: its resume file travels nowhere else, and a config
    // replaces the settings defaults, so it is built from exactly those defaults.
    const launchConfig = resume.ompResumeFilePath
      ? {
          agentArgs: resolveTuiAgentLaunchArgs(resume.agent, state.settings?.agentDefaultArgs),
          agentEnv: resolveTuiAgentLaunchEnv(resume.agent, state.settings?.agentDefaultEnv),
          ompResumeFilePath: resume.ompResumeFilePath
        }
      : undefined
    return [
      [
        paneKey,
        {
          paneKey,
          tabId: entry.targetTabId,
          worktreeId: ownerKey,
          agent: resume.agent,
          providerSession: resume.providerSession,
          prompt: '',
          // Shaped like a manual workspace sleep of a finished pane: resumed lazily, on open.
          state: 'done',
          capturedAt: now,
          updatedAt: now,
          terminalTitle: entry.label,
          origin: 'worktree-sleep',
          restoreOnTabOpenOnly: true,
          ...(launchConfig ? { launchConfig } : {})
        }
      ]
    ]
  })
}

function buildPayload(
  state: AppState,
  plan: WorkingSetRestorePlan,
  deps: WorkingSetApplyDeps
): WorkspaceSessionState {
  const ownerKey = plan.scope.ownerKey
  const now = deps.now()
  const base = buildWorkspaceSessionPayload(state)
  const sortOrderByTarget = new Map(plan.railGroups.flat().map((id, index) => [id, index]))
  const rows: TerminalTab[] = plan.entries.map((entry) => ({
    id: entry.targetTabId,
    ptyId: null,
    worktreeId: ownerKey,
    title: entry.label,
    // Why: hydration resets agent-looking titles to this fallback; the sealed label is what the user saw.
    defaultTitle: entry.label,
    customTitle: null,
    color: entry.color,
    isPinned: entry.isPinned,
    sortOrder: sortOrderByTarget.get(entry.targetTabId) ?? 0,
    createdAt: now,
    ...(entry.launch.launchProfileId ? { launchProfileId: entry.launch.launchProfileId } : {}),
    ...(entry.launch.launchAgent ? { launchAgent: entry.launch.launchAgent } : {}),
    ...(entry.launch.shellOverride ? { shellOverride: entry.launch.shellOverride } : {}),
    ...(entry.startupCwd ? { startupCwd: entry.startupCwd } : {}),
    // Why: only automatic entries may start with their workspace; the rest wait to be opened.
    // The continuity verdict rides with the marker because the resume handle cannot carry it, and
    // without it the surface promises an exact resume for a conversation nobody could confirm.
    ...(entry.wake === 'automatic'
      ? {}
      : {
          dormancy: terminalTabDormancy(
            'working-set-restore',
            resolveDormantResumeContinuity(entry.panes)
          )
        })
  }))
  const groups: TabGroup[] = plan.railGroups.map((tabOrder) => {
    const activeTabId =
      plan.activeTabId && tabOrder.includes(plan.activeTabId) ? plan.activeTabId : tabOrder[0]
    return {
      id: deps.newId(),
      worktreeId: ownerKey,
      activeTabId,
      tabOrder,
      recentTabIds: [activeTabId]
    }
  })
  const groupIdByTarget = new Map(
    groups.flatMap((group) => group.tabOrder.map((id) => [id, group.id] as const))
  )
  const unified: Tab[] = plan.entries.map((entry) => ({
    id: entry.targetTabId,
    entityId: entry.targetTabId,
    groupId: groupIdByTarget.get(entry.targetTabId)!,
    worktreeId: ownerKey,
    contentType: 'terminal',
    label: entry.label,
    customLabel: null,
    color: entry.color,
    sortOrder: sortOrderByTarget.get(entry.targetTabId) ?? 0,
    createdAt: now,
    isPreview: false,
    isPinned: entry.isPinned
  }))
  const activeTabId = plan.activeTabId ?? plan.railGroups[0]?.[0] ?? null
  const activeGroup =
    groups.find((group) => activeTabId !== null && group.tabOrder.includes(activeTabId)) ??
    groups[0]
  const records = plan.entries.flatMap((entry) => sleepingRecords(state, ownerKey, entry, now))
  return {
    ...base,
    tabsByWorktree: { ...base.tabsByWorktree, [ownerKey]: rows },
    terminalLayoutsByTabId: {
      ...base.terminalLayoutsByTabId,
      ...Object.fromEntries(plan.entries.map((entry) => [entry.targetTabId, paneLayout(entry)]))
    },
    activeTabIdByWorktree: { ...base.activeTabIdByWorktree, [ownerKey]: activeTabId },
    unifiedTabs: { ...base.unifiedTabs, [ownerKey]: unified },
    tabGroups: { ...base.tabGroups, [ownerKey]: groups },
    tabGroupLayouts: {
      ...base.tabGroupLayouts,
      [ownerKey]: evenChain<TabGroup, TabGroupLayoutNode>(
        groups,
        (group) => ({ type: 'leaf', groupId: group.id }),
        (first, second, ratio) => ({ type: 'split', direction: 'horizontal', first, second, ratio })
      )
    },
    activeGroupIdByWorktree: { ...base.activeGroupIdByWorktree, [ownerKey]: activeGroup.id },
    // Why: without this, opening the workspace could add the default template on top of the rail.
    defaultTerminalTabsAppliedByWorktreeId: {
      ...base.defaultTerminalTabsAppliedByWorktreeId,
      [ownerKey]: true
    },
    sleepingAgentSessionsByPaneKey: {
      ...base.sleepingAgentSessionsByPaneKey,
      ...Object.fromEntries(records)
    }
  }
}

function hydrate(state: AppState, session: WorkspaceSessionState, ownerKey: string): void {
  const options = { replaceWorkspaceKeys: [ownerKey] }
  state.hydrateWorkspaceSession(session, options)
  state.hydrateTabsSession(session, options)
}

function verify(
  state: AppState,
  plan: WorkingSetRestorePlan,
  expectedRecords: number
): string | null {
  const ownerKey = plan.scope.ownerKey
  const rowIds = (state.tabsByWorktree[ownerKey] ?? []).map((tab) => tab.id).sort()
  const planned = plan.entries.map((entry) => entry.targetTabId).sort()
  if (rowIds.join('\n') !== planned.join('\n')) {
    return `rows ${rowIds.length}/${planned.length}`
  }
  const groupOrder = (state.groupsByWorktree[ownerKey] ?? []).map((group) => group.tabOrder)
  if (JSON.stringify(groupOrder) !== JSON.stringify(plan.railGroups)) {
    return 'rail order'
  }
  const recordCount = Object.values(state.sleepingAgentSessionsByPaneKey).filter(
    (record) => record.tabId !== undefined && planned.includes(record.tabId)
  ).length
  return recordCount === expectedRecords ? null : `resume handles ${recordCount}/${expectedRecords}`
}

export function applyWorkingSetRestorePlan(
  plan: WorkingSetRestorePlan,
  deps: WorkingSetApplyDeps
): WorkingSetApplyResult {
  if (plan.blockers.length > 0) {
    return { status: 'refused', blockers: plan.blockers }
  }
  const ownerKey = plan.scope.ownerKey
  const state = deps.store.getState()
  // Effect-time check: the plan was made against an empty workspace.
  if (countWorkspaceOpenTabs(state, ownerKey) > 0) {
    return workspaceFingerprint(state, ownerKey) === planFingerprint(plan)
      ? { status: 'already-applied', workingSetId: plan.workingSetId }
      : { status: 'target-changed' }
  }
  const prior = buildWorkspaceSessionPayload(state)
  const payload = buildPayload(state, plan, deps)
  const expectedRecords = plan.entries
    .flatMap((entry) => entry.panes)
    .filter((pane) => pane.resumeOnOpen && !pane.blockers.includes('live-elsewhere')).length
  let failure: { stage: 'hydrate' | 'verify'; detail: string } | null = null
  try {
    hydrate(state, payload, ownerKey)
    const detail = verify(deps.store.getState(), plan, expectedRecords)
    if (detail) {
      failure = { stage: 'verify', detail }
    }
  } catch (error) {
    failure = { stage: 'hydrate', detail: error instanceof Error ? error.message : String(error) }
  }
  if (!failure) {
    return {
      status: 'applied',
      workingSetId: plan.workingSetId,
      ownerKey,
      targetTabIds: plan.entries.map((entry) => entry.targetTabId),
      resumeOnOpen: expectedRecords
    }
  }
  let rolledBack = false
  try {
    hydrate(deps.store.getState(), prior, ownerKey)
    rolledBack = countWorkspaceOpenTabs(deps.store.getState(), ownerKey) === 0
  } catch {
    rolledBack = false
  }
  return { status: 'failed', ...failure, rolledBack }
}
