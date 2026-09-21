import type {
  AgentStatusClearIpcPayload,
  AgentStatusIpcPayload,
  MigrationUnsupportedPtyEntry
} from '../../shared/agent-status-types'
import type { AgentInterruptInferenceRequest } from '../../shared/agent-interrupt-intent'
import type { AgentQuestionAnsweredInferenceRequest } from '../../shared/agent-question-answered-intent'
import type { ComputerAwakeStatus } from '../../shared/computer-awake-mode'
import type {
  LiveAgentSessionPresenceRequest,
  LiveAgentSessionPresenceResponse,
  LiveSessionCollisionNotice,
  LiveSessionMaterializationRequest,
  LiveSessionMaterializationResponse
} from '../../shared/live-agent-session-presence-types'

export type AgentStatusApi = {
  /** Listen for agent status updates forwarded from native hook receivers. */
  onSet: (callback: (data: AgentStatusIpcPayload) => void) => () => void
  /** Listen for main-process cleanup that evicted cached hook status. */
  onClear: (callback: (data: AgentStatusClearIpcPayload) => void) => () => void
  /** Return the current main-process hook cache after renderer hydration. */
  getSnapshot: () => Promise<AgentStatusIpcPayload[]>
  inferInterrupt: (request: AgentInterruptInferenceRequest) => Promise<boolean>
  /** Guarded clear for an answered AskUserQuestion wait — the CLI emits no hook at answer time, so the renderer reports the submit keystroke. */
  inferQuestionAnswered: (request: AgentQuestionAnsweredInferenceRequest) => Promise<boolean>
  /** Listen for PTYs on a legacy numeric pane key that have registry-backed UUID pane proof. */
  onMigrationUnsupported: (callback: (entry: MigrationUnsupportedPtyEntry) => void) => () => void
  onMigrationUnsupportedClear: (callback: (data: { ptyId: string }) => void) => () => void
  onLegacyWorkerTerminalRecovery: (
    callback: (data: {
      paneKey: string
      resolution: 'adopted' | 'exited' | 'rolled_back'
      ptyId?: string
    }) => void
  ) => () => void
  getMigrationUnsupportedSnapshot: () => Promise<MigrationUnsupportedPtyEntry[]>
  /** Where this exact provider session is live right now, across every window. */
  readLivePresence: (
    request: LiveAgentSessionPresenceRequest
  ) => Promise<LiveAgentSessionPresenceResponse>
  /** Checks presence and, when clear or accepted, reserves the right to materialize. */
  reserveMaterialization: (
    request: LiveSessionMaterializationRequest
  ) => Promise<LiveSessionMaterializationResponse>
  /** Names the tab a granted materialization opened, so its runtime can hand off. */
  attachMaterializationTab: (args: { operationId: string; tabId: string }) => Promise<boolean>
  /** Gives back a reservation whose materialization will not happen. */
  releaseMaterialization: (args: { operationId: string }) => Promise<void>
  /** A pane began reporting a provider session already live in another pane. */
  onLiveCollision: (callback: (notice: LiveSessionCollisionNotice) => void) => () => void
  /** Drop a paneKey from the main-process hook cache and on-disk last-status file. Fire-and-forget. */
  drop: (paneKey: string) => void
  /** Drop every cached hook status under one terminal tab prefix. Fire-and-forget. */
  dropByTabPrefix: (tabId: string) => void
  /** Permanently retire one pane's hook authority while siblings stay live. */
  retirePaneAuthority: (paneKey: string) => void
  /** Move hook authority when a live pane is detached into another tab. */
  transferPaneAuthority: (args: { fromPaneKey: string; toPaneKey: string; ptyId?: string }) => void
}

export type AgentTrustApi = {
  markTrusted: (args: {
    preset: 'cursor' | 'copilot' | 'codex'
    workspacePath: string
    connectionId?: string
  }) => Promise<void>
}

export type AgentAwakeApi = {
  getStatus: () => Promise<ComputerAwakeStatus>
  onChanged: (callback: (status: ComputerAwakeStatus) => void) => () => void
}
