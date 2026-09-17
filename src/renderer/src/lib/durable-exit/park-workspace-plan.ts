import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { getAgentResumeArgv, isResumableTuiAgent } from '../../../../shared/agent-session-resume'
import type { ParkKeepReason } from '../../../../shared/durable-exit-types'
import type { PtyProcessInspection } from '../../../../shared/pty-process-inspection'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { isTerminalTabDormant } from '@/components/terminal/background-terminal-worktree-mount'
import type { AgentHibernationPlannerSnapshot } from '../agent-hibernation-planner'
import { lastInputBlocksHibernation } from '../agent-hibernation-input-guard'
import { getEntryTabId, toRuntimePtyId } from '../agent-hibernation-pane-verdict'

export type ParkPlanSnapshot = Pick<
  AgentHibernationPlannerSnapshot,
  | 'tabsByWorktree'
  | 'terminalLayoutsByTabId'
  | 'ptyIdsByTabId'
  | 'mobileLockedPtyIds'
  | 'pinnedTerminalTabIds'
  | 'agentStatusByPaneKey'
  | 'lastTerminalInputAtByPaneKey'
>

/** Whether a shell is busy: true, proven idle: false, or `unknown` when nothing can prove it. */
export type ChildProcessAnswer = boolean | 'unknown'

/**
 * Idle needs the shell's own word. Measured on Windows: a cmd.exe running `ping` reported no
 * child processes, so "no children" alone would have let a park kill running work.
 */
export function childProcessAnswerFor(inspection: PtyProcessInspection): ChildProcessAnswer {
  if (inspection.unavailable) {
    return 'unknown'
  }
  if (inspection.hasChildProcesses || inspection.promptState === 'running') {
    return true
  }
  return inspection.promptState === 'prompt' ? false : 'unknown'
}

export type ParkWorkspacePlan = {
  worktreeId: string
  livePtyIds: string[]
  /** Empty exactly when every live terminal can be released without losing work. */
  keepReasons: ParkKeepReason[]
}

const REASON_ORDER: ParkKeepReason[] = [
  'agent-working',
  'agent-subagents',
  'agent-not-resumable',
  'unsent-input',
  'mobile-held',
  'shell-busy',
  'process-unknown',
  'pinned'
]

function agentKeepReason(
  entry: AgentStatusEntry,
  inputAt: number | undefined
): ParkKeepReason | null {
  if (entry.state !== 'done' || entry.interrupted === true) {
    return 'agent-working'
  }
  const dispatch = entry.orchestration?.dispatchStatus
  if (
    (entry.subagents?.length ?? 0) > 0 ||
    (entry.orchestration && !['completed', 'failed', 'circuit_broken'].includes(dispatch ?? ''))
  ) {
    return 'agent-subagents'
  }
  if (
    !entry.agentType ||
    !isResumableTuiAgent(entry.agentType) ||
    !entry.providerSession ||
    !getAgentResumeArgv(entry.agentType, entry.providerSession)
  ) {
    return 'agent-not-resumable'
  }
  if (
    typeof inputAt === 'number' &&
    Number.isFinite(inputAt) &&
    lastInputBlocksHibernation(entry, inputAt)
  ) {
    return 'unsent-input'
  }
  return null
}

/**
 * A tab's running PTYs. A dormant tab has none: after a relaunch it can still carry its old PTY id
 * as a wake hint, and treating that as a process would make every slept workspace unparkable.
 */
export function tabLivePtyIds(
  snapshot: Pick<ParkPlanSnapshot, 'ptyIdsByTabId'>,
  tab: TerminalTab
): string[] {
  return isTerminalTabDormant(tab) ? [] : (snapshot.ptyIdsByTabId[tab.id] ?? [])
}

/** The PTY ids of every workspace that still has a live terminal — the park's subjects. */
export function collectParkSubjectPtyIds(snapshot: ParkPlanSnapshot): Map<string, string[]> {
  const subjects = new Map<string, string[]>()
  for (const [worktreeId, tabs] of Object.entries(snapshot.tabsByWorktree)) {
    const ptyIds = tabs.flatMap((tab) => tabLivePtyIds(snapshot, tab))
    if (ptyIds.length > 0) {
      subjects.set(worktreeId, [...new Set(ptyIds)].sort())
    }
  }
  return subjects
}

/**
 * Whether each workspace with live terminals may be released by an explicit park. Unlike background
 * hibernation there is no idle threshold or feature switch: the user asked. Everything that would
 * lose work — or that we cannot judge — keeps the whole workspace, because Sleep releases it whole.
 */
export function planParkWorkspaces(
  snapshot: ParkPlanSnapshot,
  childProcessesByPtyId: Readonly<Record<string, ChildProcessAnswer | undefined>>,
  options: { includePinned: boolean }
): ParkWorkspacePlan[] {
  const mobileLocked = new Set(snapshot.mobileLockedPtyIds.map(toRuntimePtyId))
  const pinned = new Set(snapshot.pinnedTerminalTabIds)
  const agentByPaneKey = new Map<string, AgentStatusEntry>()
  for (const entry of Object.values(snapshot.agentStatusByPaneKey)) {
    if (entry) {
      agentByPaneKey.set(entry.paneKey, entry)
    }
  }
  const plans: ParkWorkspacePlan[] = []
  for (const [worktreeId, livePtyIds] of collectParkSubjectPtyIds(snapshot)) {
    const reasons = new Set<ParkKeepReason>()
    for (const tab of snapshot.tabsByWorktree[worktreeId] ?? []) {
      const tabPtyIds = tabLivePtyIds(snapshot, tab)
      if (tabPtyIds.length === 0) {
        continue
      }
      if (pinned.has(tab.id) && !options.includePinned) {
        reasons.add('pinned')
      }
      const leafByPtyId = new Map<string, string>()
      for (const [leafId, ptyId] of Object.entries(
        snapshot.terminalLayoutsByTabId[tab.id]?.ptyIdsByLeafId ?? {}
      )) {
        leafByPtyId.set(ptyId, leafId)
      }
      for (const ptyId of tabPtyIds) {
        if (mobileLocked.has(toRuntimePtyId(ptyId))) {
          reasons.add('mobile-held')
        }
        const leafId = leafByPtyId.get(ptyId)
        const paneKey = leafId ? `${tab.id}:${leafId}` : null
        const entry = paneKey ? agentByPaneKey.get(paneKey) : undefined
        if (entry && getEntryTabId(entry) === tab.id && parsePaneKey(entry.paneKey)) {
          const reason = agentKeepReason(
            entry,
            snapshot.lastTerminalInputAtByPaneKey[entry.paneKey]
          )
          if (reason) {
            reasons.add(reason)
          }
          continue
        }
        // Why: a shell's children (a dev server, a build) die with it and nothing can resume them.
        const children = childProcessesByPtyId[ptyId]
        if (children === true) {
          reasons.add('shell-busy')
        } else if (children !== false) {
          reasons.add('process-unknown')
        }
      }
    }
    plans.push({
      worktreeId,
      livePtyIds,
      keepReasons: REASON_ORDER.filter((reason) => reasons.has(reason))
    })
  }
  return plans.sort((a, b) => a.worktreeId.localeCompare(b.worktreeId))
}
