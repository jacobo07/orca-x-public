import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import {
  getAgentResumeArgv,
  isResumableTuiAgent,
  type SleepingAgentSessionRecord
} from '../../../shared/agent-session-resume'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../shared/terminal-tab-types'
import { lastInputBlocksHibernation } from './agent-hibernation-input-guard'
import { isCompletedPiCompatibleAgentWithLiveRecoveryRecord } from './pi-compatible-live-recovery-record'
import { parseRemoteRuntimePtyId } from '@/runtime/runtime-terminal-stream'

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
  | 'tab-pinned'

export type EligiblePane = {
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

export type PaneVerdict =
  | { eligible: true; pane: EligiblePane }
  | { eligible: false; reason: AgentHibernationExclusionReason }

export function excluded(reason: AgentHibernationExclusionReason): PaneVerdict {
  return { eligible: false, reason }
}

export function toRuntimePtyId(ptyId: string): string {
  return parseRemoteRuntimePtyId(ptyId)?.handle ?? ptyId
}

export function getEntryTabId(entry: AgentStatusEntry): string | null {
  if (entry.tabId) {
    return entry.tabId
  }
  return parsePaneKey(entry.paneKey)?.tabId ?? null
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

// Why: provider done hooks can fire mid-Dispatch; only runtime-confirmed settlement makes sleep safe.
const hasUnsettledOrUnknownDispatch = ({ orchestration }: AgentStatusEntry): boolean =>
  orchestration
    ? !['completed', 'failed', 'circuit_broken'].includes(orchestration.dispatchStatus ?? '')
    : false

export function classifyPane(args: {
  entry: AgentStatusEntry
  tab: TerminalTab
  layout: TerminalLayoutSnapshot | undefined
  livePtyIds: Set<string>
  sleepingAgentSessionsByPaneKey: Record<string, SleepingAgentSessionRecord | undefined>
  lastTerminalInputAtByPaneKey: Record<string, number | undefined>
  foregroundTerminalLastSeenAtByTabId: Record<string, number | undefined>
  mobileLockedPtyIds: Set<string>
  tabPinned: boolean
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
  const alreadySleeping = Boolean(sleepingRecord) && !hasOnlyLivePiCompatibleRecoveryIdentity
  // Why: a pin is standing user intent, so it outranks every transient reason;
  // an already-asleep pane still says so, because pinning does not wake it.
  if (args.tabPinned && !alreadySleeping) {
    return excluded('tab-pinned')
  }
  // Split in the original short-circuit order, so the admitted set is unchanged.
  if (entry.state !== 'done') {
    return excluded('agent-busy')
  }
  if (entry.interrupted === true) {
    return excluded('agent-interrupted')
  }
  if ((entry.subagents?.length ?? 0) > 0) {
    return excluded('has-subagents')
  }
  if (hasUnsettledOrUnknownDispatch(entry)) {
    return excluded('dispatch-unsettled')
  }
  if (alreadySleeping) {
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
