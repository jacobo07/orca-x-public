import type { AiVaultSessionTitle } from './ai-vault-session-title'
import type { TuiAgent } from './tui-agent'

// ─── Terminal Tab (legacy — used by persistence and TerminalContentSlice) ─
export type TerminalTab = {
  id: string
  ptyId: string | null
  worktreeId: string
  title: string
  /** Stable fallback label for default-named terminals ("Terminal 1", etc.).
   *  Why: agent CLIs overwrite the live title via OSC updates, but Orca still
   *  needs the original terminal label for numbering and reset behavior. */
  defaultTitle?: string
  /** Stable opt-in label derived from the first known agent prompt. */
  generatedTitle?: string | null
  /** Stable AI Vault conversation name, bound to its provider session identity. */
  aiVaultTitle?: AiVaultSessionTitle | null
  /** Stable label from the tab-bar Quick Command that created this terminal. */
  quickCommandLabel?: string | null
  customTitle: string | null
  color: string | null
  /** Pinned tabs survive "close others"; host-persisted for remote servers. */
  isPinned?: boolean
  /** Per-tab view preference (terminal xterm vs native chat); host-persisted so
   *  paired clients converge. Optional: older persisted tabs default to 'terminal'. */
  viewMode?: 'terminal' | 'chat'
  sortOrder: number
  createdAt: number
  /** Bumped on shutdown so TerminalPane remounts with a fresh PTY. */
  generation?: number
  /** Why: records the shell this tab was opened with (e.g. 'wsl.exe') so the
   *  PTY and tab icon stay stable even if the default shell setting changes
   *  later. Older persisted tabs may omit this field. */
  shellOverride?: string
  /** Why: the launch profile the user picked, which `shellOverride` cannot express — that field
   *  holds a resolved executable, so two profiles hosting a command in the same shell are
   *  indistinguishable in it, and a profile carrying a command leaves no trace there at all.
   *  Stored as the profile's stable id, never its label: labels are renameable and may be shared,
   *  so a tab pointing at one would re-point itself the moment the user edited it. Older tabs omit
   *  this and are read through `resolveTerminalLaunchProfileIdentity` instead. */
  launchProfileId?: string
  /** Keeps an ephemeral host fallback out of the active project's runtime. */
  forceHostRuntime?: boolean
  /** Why: explorer-created terminals can start below the workspace root while
   *  still belonging to that workspace for tab/session ownership. */
  startupCwd?: string
  /** Why: the coding-harness agent Orca launched in this tab. Lets the tab bar
   *  show the provider icon immediately, before the agent emits its first hook
   *  event (a freshly-launched, idle agent reports no live status yet). Live
   *  hook status overrides this once the agent does anything. Plain terminals
   *  and manually-started agents omit it. */
  launchAgent?: TuiAgent
  /** Why: when `setActiveWorktree` bumps generation on all-dead tabs to drive a
   *  TerminalPane remount, the fresh PTY that results is caused by navigation,
   *  not by the user doing work. Without this flag the resulting
   *  `updateTabPtyId` call would call `bumpWorktreeActivity` and flip the
   *  sidebar's recency sort on every click — the reorder-on-click bug. The
   *  flag is set by `setActiveWorktree` and consumed by the activation-driven
   *  PTY lifecycle calls that follow, which then suppress activity bumps and
   *  `sortEpoch` increments. Split layouts use a numeric count because one tab
   *  can remount several panes. Never persisted — it is a transient handoff. */
  pendingActivationSpawn?: boolean | number
  /** Why: positive evidence that this row is meant to have no process until someone opens it.
   *  A tab without a PTY is not dormant on its own — a new or failed terminal looks the same.
   *  Cleared only when a PTY binds, so a failed open stays dormant across a restart. */
  dormancy?: TerminalTabDormancy
  /** Someone explicitly asked to open this dormant tab in this session. Never persisted (the
   *  session schema drops it), so a restart returns the tab to dormant until a PTY binds. */
  dormantOpenRequested?: true
}

export type TerminalTabDormancyReason = 'working-set-restore' | 'workspace-sleep'

/**
 * What this row may honestly say about resuming — the continuity authority's verdict, carried.
 *
 * `exact` alone permits an affirmative promise: today's world confirmed the conversation.
 * `unconfirmed` means a conversation is recorded and will be ATTEMPTED, which is what the restore
 * plan does for an `unknown` verdict on purpose. Absent means nobody judged, which is also unknown.
 */
export type DormantResumeContinuity = 'exact' | 'unconfirmed' | 'claimed-elsewhere' | 'none'

export type TerminalTabDormancy = {
  reason: TerminalTabDormancyReason
  /** Absent only for a row persisted before this field existed. Every current producer states one,
   *  through `terminalTabDormancy`; a legacy row stays absent because nobody judged it. */
  resumeContinuity?: DormantResumeContinuity
}

/**
 * The only way a transition should write a dormancy marker: the verdict is a required argument.
 *
 * Not a required field on `TerminalTabDormancy` itself, measured: that type also describes rows
 * hydrated from disk, and a row persisted before the field existed legitimately has none. Forcing
 * the field there would make hydration invent a verdict for a row no classifier ever judged. So the
 * obligation sits on the producer, and `terminal-tab-dormancy-producers.test.ts` fails when a
 * production marker is written any other way.
 */
export function terminalTabDormancy(
  reason: TerminalTabDormancyReason,
  resumeContinuity: DormantResumeContinuity
): Required<TerminalTabDormancy> {
  return { reason, resumeContinuity }
}

export type TerminalPaneSplitDirection = 'vertical' | 'horizontal'

export type TerminalPaneLayoutNode =
  | {
      type: 'leaf'
      leafId: string
    }
  | {
      type: 'split'
      direction: TerminalPaneSplitDirection
      first: TerminalPaneLayoutNode
      second: TerminalPaneLayoutNode
      /** Flex ratio of the first child (0–1). Defaults to 0.5 if absent. */
      ratio?: number
    }

export type TerminalLayoutSnapshot = {
  root: TerminalPaneLayoutNode | null
  activeLeafId: string | null
  expandedLeafId: string | null
  /** Live PTY IDs per leaf for in-session remounts such as tab-group moves.
   *  Not used for app restart because PTYs are transient processes. */
  ptyIdsByLeafId?: Record<string, string>
  /** Serialized terminal buffers per leaf for scrollback restoration on restart. */
  buffersByLeafId?: Record<string, string>
  /** Durable scrollback snapshot refs per leaf; raw bytes live outside session JSON. */
  scrollbackRefsByLeafId?: Record<string, string>
  /** User-assigned pane titles, keyed by stable layout leaf UUID.
   *  Persisted alongside buffers via the existing session:set flow. */
  titlesByLeafId?: Record<string, string>
}
