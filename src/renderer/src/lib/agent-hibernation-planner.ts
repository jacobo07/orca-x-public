import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import {
  getAgentResumeArgv,
  isResumableTuiAgent,
  type SleepingAgentSessionRecord
} from '../../../shared/agent-session-resume'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import { lastInputBlocksHibernation } from './agent-hibernation-input-guard'
import { isCompletedPiCompatibleAgentWithLiveRecoveryRecord } from './pi-compatible-live-recovery-record'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../shared/terminal-tab-types'
import { parseRemoteRuntimePtyId } from '@/runtime/runtime-terminal-stream'

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
  mobileLockedPtyIds: string[]
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

type EligiblePane = {
  paneKey: string
  tabId: string
  leafId: string
  ptyId: string
  runtimePtyId: string
  providerSessionId: string
  state: AgentStatusEntry['state']
  updatedAt: number
  effectiveIdleStart: number
  inputAt: number
}

function toRuntimePtyId(ptyId: string): string {
  return parseRemoteRuntimePtyId(ptyId)?.handle ?? ptyId
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

function getPaneLivePtyId(
  entry: AgentStatusEntry,
  layout: TerminalLayoutSnapshot | undefined
): { leafId: string; ptyId: string } | null {
  const parsed = parsePaneKey(entry.paneKey)
  if (!parsed || (entry.tabId && parsed.tabId !== entry.tabId)) {
    return null
  }
  const ptyId = layout?.ptyIdsByLeafId?.[parsed.leafId]
  return ptyId ? { leafId: parsed.leafId, ptyId } : null
}

function getEntryTabId(entry: AgentStatusEntry): string | null {
  if (entry.tabId) {
    return entry.tabId
  }
  return parsePaneKey(entry.paneKey)?.tabId ?? null
}

// Why: provider done hooks can fire mid-Dispatch; only runtime-confirmed settlement makes sleep safe.
const hasUnsettledOrUnknownDispatch = ({ orchestration }: AgentStatusEntry): boolean =>
  orchestration
    ? !['completed', 'failed', 'circuit_broken'].includes(orchestration.dispatchStatus ?? '')
    : false

/**
 * Why a pane was not admitted. One evaluation produces both this and the
 * candidate list, so the planner stays the single eligibility authority — a
 * surface that re-derived these would be a second one.
 */
export type AgentHibernationExclusionReason =
  | 'feature-disabled'
  | 'worktree-active'
  | 'runtime-liveness-unknown'
  | 'tab-foreground'
  | 'agent-busy'
  | 'agent-interrupted'
  | 'has-subagents'
  | 'dispatch-unsettled'
  | 'already-sleeping'
  | 'pane-mismatch'
  | 'not-resumable-agent'
  | 'not-idle-long-enough'
  | 'recent-input'
  | 'no-live-pane'
  | 'mobile-locked'

export type AgentHibernationPaneClassification = {
  paneKey: string
  worktreeId: string
  tabId: string
  eligible: boolean
  /** null exactly when eligible. */
  reason: AgentHibernationExclusionReason | null
}

type PaneVerdict = { eligible: true; pane: EligiblePane } | { eligible: false; reason: AgentHibernationExclusionReason }

function excluded(reason: AgentHibernationExclusionReason): PaneVerdict {
  return { eligible: false, reason }
}

function classifyPane(args: {
  entry: AgentStatusEntry
  tab: TerminalTab
  layout: TerminalLayoutSnapshot | undefined
  livePtyIds: Set<string>
  sleepingAgentSessionsByPaneKey: AgentHibernationPlannerSnapshot['sleepingAgentSessionsByPaneKey']
  lastTerminalInputAtByPaneKey: AgentHibernationPlannerSnapshot['lastTerminalInputAtByPaneKey']
  foregroundTerminalLastSeenAtByTabId: AgentHibernationPlannerSnapshot['foregroundTerminalLastSeenAtByTabId']
  mobileLockedPtyIds: Set<string>
  now: number
  idleMs: number
}): PaneVerdict {
  const {
    entry,
    tab,
    layout,
    livePtyIds,
    sleepingAgentSessionsByPaneKey,
    lastTerminalInputAtByPaneKey,
    foregroundTerminalLastSeenAtByTabId,
    mobileLockedPtyIds
  } = args
  const sleepingRecord = sleepingAgentSessionsByPaneKey[entry.paneKey]
  // Why: a Pi-compatible done hook ends a turn, not its TUI. Its live
  // recovery checkpoint must not make the pane look already hibernated.
  const hasOnlyLivePiCompatibleRecoveryIdentity =
    isCompletedPiCompatibleAgentWithLiveRecoveryRecord(entry, sleepingRecord, tab.worktreeId)
  // Split in the original short-circuit order, so the admitted set is unchanged.
  if (entry.state !== 'done') {
    return excluded('agent-busy')
  }
  if (entry.interrupted === true) {
    return excluded('agent-interrupted')
  }
  if (Boolean(entry.subagents?.length)) {
    return excluded('has-subagents')
  }
  if (hasUnsettledOrUnknownDispatch(entry)) {
    return excluded('dispatch-unsettled')
  }
  if (sleepingRecord && !hasOnlyLivePiCompatibleRecoveryIdentity) {
    return excluded('already-sleeping')
  }
  if (
    getEntryTabId(entry) !== tab.id ||
    (entry.worktreeId && entry.worktreeId !== tab.worktreeId)
  ) {
    return excluded('pane-mismatch')
  }
  if (!entry.agentType || !isResumableTuiAgent(entry.agentType) || !entry.providerSession) {
    return excluded('not-resumable-agent')
  }
  if (!getAgentResumeArgv(entry.agentType, entry.providerSession)) {
    return excluded('not-resumable-agent')
  }
  // Why: returning to the containing terminal tab should restart sleep even
  // without pane input; sibling tabs in the worktree should keep their age.
  const foregroundLastSeenAt = foregroundTerminalLastSeenAtByTabId[tab.id]
  const effectiveIdleStart = Math.max(
    entry.updatedAt,
    typeof foregroundLastSeenAt === 'number' && Number.isFinite(foregroundLastSeenAt)
      ? foregroundLastSeenAt
      : 0
  )
  if (args.now - effectiveIdleStart < args.idleMs) {
    return excluded('not-idle-long-enough')
  }
  const inputAt = lastTerminalInputAtByPaneKey[entry.paneKey]
  // Why: killing the PTY discards the TUI composer's draft and any queued
  // messages. The old input-after-done compare missed drafts typed while the
  // agent was still working — the class that lost a user's draft in prod.
  if (
    typeof inputAt === 'number' &&
    Number.isFinite(inputAt) &&
    lastInputBlocksHibernation(entry, inputAt)
  ) {
    return excluded('recent-input')
  }
  const livePane = getPaneLivePtyId(entry, layout)
  if (!livePane) {
    return excluded('no-live-pane')
  }
  const { leafId, ptyId } = livePane
  const runtimePtyId = toRuntimePtyId(ptyId)
  if (!livePtyIds.has(runtimePtyId)) {
    return excluded('no-live-pane')
  }
  // Why: a pane Mobile is holding is not dead; naming it as such would send the
  // user looking for a crash instead of at their phone.
  if (mobileLockedPtyIds.has(runtimePtyId)) {
    return excluded('mobile-locked')
  }
  return {
    eligible: true,
    pane: {
      paneKey: entry.paneKey,
      tabId: tab.id,
      leafId,
      ptyId,
      runtimePtyId,
      providerSessionId: entry.providerSession.id,
      state: entry.state,
      updatedAt: entry.updatedAt,
      effectiveIdleStart,
      inputAt: typeof inputAt === 'number' && Number.isFinite(inputAt) ? inputAt : 0
    }
  }
}

function signatureFor(worktreeId: string, panes: EligiblePane[]): string {
  const parts = panes
    .slice()
    .sort((a, b) => a.paneKey.localeCompare(b.paneKey))
    .map(
      (pane) =>
        `${pane.paneKey}:${pane.ptyId}:${pane.runtimePtyId}:${pane.providerSessionId}:${pane.state}:${pane.updatedAt}:${pane.effectiveIdleStart}:${pane.inputAt}`
    )
  return `${worktreeId}|${parts.join('|')}`
}

function candidateIdFor(worktreeId: string, paneKey: string): string {
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
      const tabReason =
        worktreeReason ?? (foregroundTerminalTabIds.has(tab.id) ? 'tab-foreground' : null)
      if (tabReason) {
        for (const entry of entries) {
          walked.push({ worktreeId, tabId: tab.id, paneKey: entry.paneKey, verdict: excluded(tabReason) })
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
    candidates.push({
      id: candidateIdFor(walked.worktreeId, eligible.paneKey),
      worktreeId: walked.worktreeId,
      paneKey: eligible.paneKey,
      tabId: eligible.tabId,
      leafId: eligible.leafId,
      paneKeys: [eligible.paneKey],
      targetPtyIds: [eligible.ptyId],
      expectedRuntimePtyIds: [eligible.runtimePtyId],
      signature: signatureFor(walked.worktreeId, [eligible])
    })
  }
  return candidates
}
