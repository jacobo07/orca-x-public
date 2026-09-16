import type { AgentProviderSessionMetadata, ResumableTuiAgent } from './agent-session-resume'
import type { ExecutionHostId } from './execution-host'
import type { TuiAgent } from './tui-agent'

/**
 * A project working set: the logical composition of one workspace's terminal rail, captured so it
 * can be reconstructed later with none of its processes running.
 *
 * It records evidence, not conclusions. Launch identity and restore capability are derived on read,
 * as `resolveTerminalLaunchProfileIdentity` does for live tabs — an inference written to disk once
 * outlives the evidence that justified it.
 *
 * Coherence is a property of capture, not a field. `terminalTopologyRevisionByRepoId` was audited
 * and rejected: it is a host fencing epoch, per repo, that advances on PTY exits and incarnation
 * churn while ignoring reorder, selection, pinning and titles. A manifest projected synchronously
 * from one renderer store state cannot mix two moments; the capture producer owns that guarantee.
 *
 * Deliberately absent: PTY ids, pids, runtime incarnations, split geometry, agent env (may carry
 * secrets), prompts and assistant output (user content), and scrollback bytes (referenced only).
 */

/** Any shape change bumps this; readers refuse versions they do not know. */
export const PROJECT_WORKING_SET_MANIFEST_VERSION = 1

export type WorkingSetLocation =
  | { kind: 'repo-worktree'; repoId: string; worktreePath: string }
  | { kind: 'folder-workspace'; folderWorkspaceId: string; folderPath: string }

export type ProjectWorkingSetScope = {
  executionHostId: ExecutionHostId
  /** The exact `tabsByWorktree` key: a raw worktree id or a WorkspaceKey. */
  ownerKey: string
  /** Where it lived at capture, so a later move reads as missing instead of redirecting. */
  location: WorkingSetLocation
}

export type WorkingSetRestorePolicy =
  | 'auto-restore'
  | 'restore-on-open'
  | 'keep-dormant'
  | 'do-not-restore'

export type WorkingSetResumeEvidence =
  | {
      kind: 'provider-session'
      agent: ResumableTuiAgent
      providerSession: AgentProviderSessionMetadata
      ompResumeFilePath: string | null
    }
  | {
      kind: 'absent'
      reason: 'not-an-agent' | 'agent-not-resumable' | 'no-provider-session-captured'
    }

export type WorkingSetPane = {
  leafId: string
  title: string | null
  /** A reference into the existing scrollback store; null means none was recorded. */
  scrollbackRef: string | null
  resume: WorkingSetResumeEvidence
}

/** The live tab's raw launch fields, unresolved. */
export type WorkingSetLaunchEvidence = {
  launchProfileId: string | null
  launchAgent: TuiAgent | null
  shellOverride: string | null
}

export type WorkingSetEntry = {
  /** The terminal tab id that pane keys and sleeping records are built from. */
  tabId: string
  /** Presentation only; two entries may share it. */
  label: string
  color: string | null
  isPinned: boolean
  launch: WorkingSetLaunchEvidence
  /** null is the workspace root, which is what a live tab means by omitting it. */
  startupCwd: string | null
  restorePolicy: WorkingSetRestorePolicy
  activeLeafId: string | null
  /** Layout order. */
  panes: WorkingSetPane[]
}

export type ProjectWorkingSetManifest = {
  manifestVersion: typeof PROJECT_WORKING_SET_MANIFEST_VERSION
  workingSetId: string
  label: string | null
  createdAt: number
  scope: ProjectWorkingSetScope
  /** Rail order and the only order source: tab groups in order, each its tab ids in order. */
  railGroups: string[][]
  /** Exactly the auto-restore entries, in revival order. Never derived from rail order. */
  revivalOrder: string[]
  /** May name a dormant entry: active is not resident. */
  activeTabId: string | null
  entries: WorkingSetEntry[]
}

/** `history-only` and `not-restorable` need the world (cwd, host, profile) and are restore-time. */
export type WorkingSetRestoreCapability =
  | 'exact-resume'
  | 'restartable'
  | 'recreate-context'
  | 'history-only'
  | 'not-restorable'
  | 'unknown'

export type CaptureTimeRestoreCapability = Extract<
  WorkingSetRestoreCapability,
  'exact-resume' | 'restartable' | 'recreate-context' | 'unknown'
>
