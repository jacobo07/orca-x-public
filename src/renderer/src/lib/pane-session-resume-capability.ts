import type { AppState } from '@/store/types'
import { resolveAgentResumeLaunchTarget } from '@/lib/agent-resume-launch-target'
import { getLocalProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import {
  planRecordedAgentResume,
  type RecordedAgentResumePlan
} from '@/lib/recorded-agent-resume-plan'
import { getExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'
import {
  isAgentExitedResumeBlock,
  isLegacyWorkerResumeBlock
} from '../../../shared/agent-resume-block-precedence'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { parseExecutionHostId } from '../../../shared/execution-host'
import type { PaneForegroundAgentEntry } from '@/store/slices/pane-foreground-agent'

export type PaneSessionResumeUnavailableReason =
  | 'no-plan'
  | 'legacy-fence'
  | 'worktree-missing'
  | 'worktree-deleting'
  | 'remote'
  | 'runtime-routed'

export type PaneSessionResumeCapability =
  | { kind: 'hidden' }
  | { kind: 'available' }
  | {
      kind: 'disabled'
      /** host-outdated only comes from the click-time check, never from the store. */
      reason: 'shell-busy' | 'shell-unconfirmed' | 'shell-unsupported' | 'host-outdated'
    }
  | { kind: 'unavailable'; reason: PaneSessionResumeUnavailableReason }

export type PaneSessionResumeInput = {
  /** Any live status row means the agent TUI is still running; an exit drops it. */
  hasLiveStatus: boolean
  record: SleepingAgentSessionRecord | undefined
  foreground: PaneForegroundAgentEntry | undefined
  worktree: 'present' | 'missing' | 'deleting'
  host: 'local' | 'ssh' | 'runtime'
  hasPlan: boolean
}

/**
 * Whether this pane may offer "Resume this session". A projection of durable state only:
 * the pane's own exited record, never a title, a cwd or the latest session.
 */
export function resolvePaneSessionResumeCapability(
  input: PaneSessionResumeInput
): PaneSessionResumeCapability {
  const block = input.record?.automaticResumeBlockedBy
  if (input.hasLiveStatus || !input.record || !isAgentExitedResumeBlock(block)) {
    return { kind: 'hidden' }
  }
  // Why: main owns a fenced worker's recovery; a user relaunch would race it.
  if (isLegacyWorkerResumeBlock(block)) {
    return { kind: 'unavailable', reason: 'legacy-fence' }
  }
  if (input.worktree !== 'present') {
    return {
      kind: 'unavailable',
      reason: input.worktree === 'deleting' ? 'worktree-deleting' : 'worktree-missing'
    }
  }
  // Why: SSH panes have no foreground tracking or reservation, runtime panes launch on
  // another host; neither can be resumed safely from here yet.
  if (input.host !== 'local') {
    return { kind: 'unavailable', reason: input.host === 'ssh' ? 'remote' : 'runtime-routed' }
  }
  if (!input.hasPlan) {
    return { kind: 'unavailable', reason: 'no-plan' }
  }
  if (input.foreground?.shellForeground === true) {
    return { kind: 'available' }
  }
  if (input.foreground?.shellPromptUnsupported === true && !input.foreground.agent) {
    return { kind: 'disabled', reason: 'shell-unsupported' }
  }
  // Why: only a recognized agent proves the pane is busy; a running command, a failed
  // inspection and no reading at all all mean the prompt is unproven, which is not idle.
  return {
    kind: 'disabled',
    reason: input.foreground?.agent ? 'shell-busy' : 'shell-unconfirmed'
  }
}

export type PaneSessionResumeTarget = {
  paneKey: string
  tabId: string
  worktreeId: string
}

/** The pane's exact resume launch, or null when there is none. Shares cold restore's planner. */
export function planPaneSessionResume(
  state: AppState,
  target: PaneSessionResumeTarget
): { record: SleepingAgentSessionRecord; plan: RecordedAgentResumePlan } | null {
  const record = state.sleepingAgentSessionsByPaneKey[target.paneKey]
  if (!record || record.worktreeId !== target.worktreeId) {
    return null
  }
  const worktree = state.getKnownWorktreeById(target.worktreeId)
  const repo = worktree ? state.repos.find((entry) => entry.id === worktree.repoId) : null
  const tab = (state.tabsByWorktree[target.worktreeId] ?? []).find((t) => t.id === target.tabId)
  // Why the tab override: the line is typed into this pane's shell, like cold restore's.
  const launchTarget = resolveAgentResumeLaunchTarget({
    projectRuntime: getLocalProjectExecutionRuntimeContext(state, target.worktreeId),
    connectionId: repo?.connectionId,
    executionHostId: getExecutionHostIdForWorktree(state, target.worktreeId),
    worktreePath: worktree?.path,
    terminalWindowsShell: state.settings?.terminalWindowsShell,
    tabShellOverride: tab?.shellOverride
  })
  const plan = planRecordedAgentResume({
    agent: record.agent,
    providerSession: record.providerSession,
    launchConfig: record.launchConfig,
    settings: state.settings,
    target: launchTarget
  })
  return plan ? { record, plan } : null
}

export function readPaneSessionResumeCapability(
  state: AppState,
  target: PaneSessionResumeTarget
): PaneSessionResumeCapability {
  const record = state.sleepingAgentSessionsByPaneKey[target.paneKey]
  // Why first: this runs as a per-pane store selector, and nearly every pane is hidden.
  if (!record || !isAgentExitedResumeBlock(record.automaticResumeBlockedBy)) {
    return { kind: 'hidden' }
  }
  const worktree = state.getKnownWorktreeById(target.worktreeId)
  const repo = worktree ? state.repos.find((entry) => entry.id === worktree.repoId) : null
  const hostKind = parseExecutionHostId(
    getExecutionHostIdForWorktree(state, target.worktreeId)
  )?.kind
  return resolvePaneSessionResumeCapability({
    hasLiveStatus: target.paneKey in state.agentStatusByPaneKey,
    record: state.sleepingAgentSessionsByPaneKey[target.paneKey],
    foreground: state.paneForegroundAgentByPaneKey[target.paneKey],
    worktree: state.deleteStateByWorktreeId?.[target.worktreeId]?.isDeleting
      ? 'deleting'
      : worktree
        ? 'present'
        : 'missing',
    host:
      repo?.connectionId || hostKind === 'ssh'
        ? 'ssh'
        : hostKind === 'runtime'
          ? 'runtime'
          : 'local',
    hasPlan: planPaneSessionResume(state, target) !== null
  })
}
