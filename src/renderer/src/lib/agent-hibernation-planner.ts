import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../shared/terminal-tab-types'
import {
  classifyPane,
  excluded,
  getEntryTabId,
  toRuntimePtyId,
  type AgentHibernationExclusionReason,
  type EligiblePane,
  type PaneVerdict
} from './agent-hibernation-pane-verdict'

export type { AgentHibernationExclusionReason } from './agent-hibernation-pane-verdict'

export const DEFAULT_AGENT_HIBERNATION_IDLE_MS = 30 * 60 * 1000
export const MIN_AGENT_HIBERNATION_IDLE_MS = 60 * 1000
export const MAX_AGENT_HIBERNATION_IDLE_MS = 24 * 60 * 60 * 1000

export type AgentHibernationPlannerSnapshot = {
  settings: Pick<GlobalSettings, 'experimentalAgentHibernation' | 'agentHibernationIdleMs'> | null
  activeWorktreeId: string | null
  foregroundTerminalTabIds: string[]
  tabsByWorktree: Record<string, TerminalTab[]>
  terminalLayoutsByTabId: Record<string, TerminalLayoutSnapshot | undefined>
  ptyIdsByTabId: Record<string, string[] | undefined>
  runtimeLivePtyIdsByWorktreeId?: Record<string, string[] | undefined>
  runtimeLivenessRequiredWorktreeIds?: string[]
  /** The host each runtime worktree lives on; part of what a user authorized. */
  runtimeEnvironmentIdByWorktreeId?: Record<string, string | undefined>
  /** Host PTY behind each live runtime identity (a terminal handle, for paired clients). */
  runtimeHostPtyIdByRuntimeIdByWorktreeId?: Record<string, Record<string, string> | undefined>
  mobileLockedPtyIds: string[]
  /** Terminal tabs the user pinned: kept awake, never slept, never woken by the pin. */
  pinnedTerminalTabIds: string[]
  agentStatusByPaneKey: Record<string, AgentStatusEntry | undefined>
  sleepingAgentSessionsByPaneKey: Record<string, SleepingAgentSessionRecord | undefined>
  lastTerminalInputAtByPaneKey: Record<string, number | undefined>
  foregroundTerminalLastSeenAtByTabId: Record<string, number | undefined>
  now: number
}

export type AgentHibernationCandidate = {
  id: string
  worktreeId: string
  paneKey: string
  tabId: string
  leafId: string
  paneKeys: string[]
  targetPtyIds: string[]
  expectedRuntimePtyIds: string[]
  signature: string
}

export function getEffectiveAgentHibernationIdleMs(value: unknown): number {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= MIN_AGENT_HIBERNATION_IDLE_MS &&
    value <= MAX_AGENT_HIBERNATION_IDLE_MS
    ? value
    : DEFAULT_AGENT_HIBERNATION_IDLE_MS
}

function getLivePtyIdsForTab(
  tab: TerminalTab,
  ptyIdsByTabId: Record<string, string[] | undefined>,
  runtimeLivePtyIdsByWorktreeId: Record<string, string[] | undefined> | undefined,
  runtimeLivenessRequired: boolean
): string[] {
  const ids = new Set<string>()
  for (const id of runtimeLivePtyIdsByWorktreeId?.[tab.worktreeId] ?? []) {
    if (typeof id === 'string' && id.length > 0) {
      ids.add(toRuntimePtyId(id))
    }
  }
  if (!runtimeLivenessRequired) {
    for (const id of ptyIdsByTabId[tab.id] ?? []) {
      if (typeof id === 'string' && id.length > 0) {
        ids.add(toRuntimePtyId(id))
      }
    }
  }
  return [...ids]
}

export type AgentHibernationPaneClassification = {
  paneKey: string
  worktreeId: string
  tabId: string
  eligible: boolean
  /** null exactly when eligible. */
  reason: AgentHibernationExclusionReason | null
}

function signatureFor(
  worktreeId: string,
  environmentId: string | undefined,
  panes: EligiblePane[]
): string {
  const parts = panes
    .slice()
    .sort((a, b) => a.paneKey.localeCompare(b.paneKey))
    .map(
      (pane) =>
        `${pane.paneKey}:${pane.ptyId}:${pane.runtimePtyId}:${pane.providerSessionId}:${pane.state}:${pane.updatedAt}:${pane.effectiveIdleStart}:${pane.inputAt}`
    )
  // Why: a worktree re-homed to another host is a different subject, even with equal pty ids.
  return `${worktreeId}@${environmentId ?? ''}|${parts.join('|')}`
}

/** Exported so a caller holding a classification can name the same subject the plan does. */
export function candidateIdFor(worktreeId: string, paneKey: string): string {
  return `${worktreeId}|${paneKey}`
}

function getAgentEntriesByTabId(
  agentStatusByPaneKey: AgentHibernationPlannerSnapshot['agentStatusByPaneKey']
): Map<string, AgentStatusEntry[]> {
  const entriesByTabId = new Map<string, AgentStatusEntry[]>()
  for (const entry of Object.values(agentStatusByPaneKey)) {
    if (!entry) {
      continue
    }
    const tabId = getEntryTabId(entry)
    if (!tabId) {
      continue
    }
    const entries = entriesByTabId.get(tabId)
    if (entries) {
      entries.push(entry)
    } else {
      entriesByTabId.set(tabId, [entry])
    }
  }
  return entriesByTabId
}

type WalkedPane = {
  worktreeId: string
  tabId: string
  paneKey: string
  verdict: PaneVerdict
}

/**
 * The single evaluation. Both the candidate list and the exclusion report are
 * views of this walk, so they cannot disagree about who may sleep.
 */
function walkPanes(snapshot: AgentHibernationPlannerSnapshot): WalkedPane[] {
  const featureEnabled = snapshot.settings?.experimentalAgentHibernation === true
  const idleMs = getEffectiveAgentHibernationIdleMs(snapshot.settings?.agentHibernationIdleMs)
  const mobileLockedPtyIds = new Set(snapshot.mobileLockedPtyIds.map(toRuntimePtyId))
  const foregroundTerminalTabIds = new Set(snapshot.foregroundTerminalTabIds)
  const pinnedTerminalTabIds = new Set(snapshot.pinnedTerminalTabIds)
  const runtimeLivenessRequiredWorktreeIds = new Set(
    snapshot.runtimeLivenessRequiredWorktreeIds ?? []
  )
  const agentEntriesByTabId = getAgentEntriesByTabId(snapshot.agentStatusByPaneKey)
  const walked: WalkedPane[] = []

  for (const [worktreeId, tabs] of Object.entries(snapshot.tabsByWorktree)) {
    let worktreeReason: AgentHibernationExclusionReason | null = null
    if (!featureEnabled) {
      worktreeReason = 'feature-disabled'
    } else if (!worktreeId || worktreeId === snapshot.activeWorktreeId || tabs.length === 0) {
      worktreeReason = 'worktree-active'
    } else if (
      runtimeLivenessRequiredWorktreeIds.has(worktreeId) &&
      !Object.hasOwn(snapshot.runtimeLivePtyIdsByWorktreeId ?? {}, worktreeId)
    ) {
      worktreeReason = 'runtime-liveness-unknown'
    }

    for (const tab of tabs) {
      const entries = agentEntriesByTabId.get(tab.id) ?? []
      const tabPinned = pinnedTerminalTabIds.has(tab.id)
      const tabReason =
        worktreeReason ??
        (foregroundTerminalTabIds.has(tab.id) && !tabPinned ? 'tab-foreground' : null)
      if (tabReason) {
        for (const entry of entries) {
          walked.push({
            worktreeId,
            tabId: tab.id,
            paneKey: entry.paneKey,
            verdict: excluded(tabReason)
          })
        }
        continue
      }
      const tabLivePtyIds = getLivePtyIdsForTab(
        tab,
        snapshot.ptyIdsByTabId,
        snapshot.runtimeLivePtyIdsByWorktreeId,
        runtimeLivenessRequiredWorktreeIds.has(worktreeId)
      )
      if (tabLivePtyIds.length === 0) {
        for (const entry of entries) {
          walked.push({
            worktreeId,
            tabId: tab.id,
            paneKey: entry.paneKey,
            verdict: excluded('no-live-pane')
          })
        }
        continue
      }
      const layout = snapshot.terminalLayoutsByTabId[tab.id]
      for (const entry of entries) {
        walked.push({
          worktreeId,
          tabId: tab.id,
          paneKey: entry.paneKey,
          verdict: classifyPane({
            entry,
            tab,
            layout,
            livePtyIds: new Set(tabLivePtyIds),
            sleepingAgentSessionsByPaneKey: snapshot.sleepingAgentSessionsByPaneKey,
            lastTerminalInputAtByPaneKey: snapshot.lastTerminalInputAtByPaneKey,
            foregroundTerminalLastSeenAtByTabId: snapshot.foregroundTerminalLastSeenAtByTabId,
            mobileLockedPtyIds,
            tabPinned,
            now: snapshot.now,
            idleMs
          })
        })
      }
    }
  }
  return walked.sort(
    (a, b) => a.worktreeId.localeCompare(b.worktreeId) || a.paneKey.localeCompare(b.paneKey)
  )
}

/** Every known pane with its verdict — the planner's reasons, not a re-derivation. */
export function classifyAgentHibernationPanes(
  snapshot: AgentHibernationPlannerSnapshot
): AgentHibernationPaneClassification[] {
  return walkPanes(snapshot).map((walked) => ({
    paneKey: walked.paneKey,
    worktreeId: walked.worktreeId,
    tabId: walked.tabId,
    eligible: walked.verdict.eligible,
    reason: walked.verdict.eligible ? null : walked.verdict.reason
  }))
}

export function planAgentHibernationCandidates(
  snapshot: AgentHibernationPlannerSnapshot
): AgentHibernationCandidate[] {
  const candidates: AgentHibernationCandidate[] = []
  for (const walked of walkPanes(snapshot)) {
    if (!walked.verdict.eligible) {
      continue
    }
    const eligible = walked.verdict.pane
    const hostPtyId =
      snapshot.runtimeHostPtyIdByRuntimeIdByWorktreeId?.[walked.worktreeId]?.[
        eligible.runtimePtyId
      ] ?? eligible.runtimePtyId
    candidates.push({
      id: candidateIdFor(walked.worktreeId, eligible.paneKey),
      worktreeId: walked.worktreeId,
      paneKey: eligible.paneKey,
      tabId: eligible.tabId,
      leafId: eligible.leafId,
      paneKeys: [eligible.paneKey],
      targetPtyIds: [eligible.ptyId],
      expectedRuntimePtyIds: [hostPtyId],
      // Why: a handle re-bound to another host PTY is a new incarnation the user never saw.
      signature: `${signatureFor(
        walked.worktreeId,
        snapshot.runtimeEnvironmentIdByWorktreeId?.[walked.worktreeId],
        [eligible]
      )}>${hostPtyId}`
    })
  }
  return candidates
}
