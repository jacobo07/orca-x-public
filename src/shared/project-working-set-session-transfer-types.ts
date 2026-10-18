import type { WorkingSetReadResult, WorkingSetScopeKey } from './project-working-set-store-types'

/** A continue onto an SSH host asks main to copy each Claude pane's transcript there first. */
export type WorkingSetSessionTransferRequest = {
  scope: WorkingSetScopeKey
  workingSetId: string
  /** The SSH target the continue moves to. */
  connectionId: string
  /** Keyed `${tabId}:${leafId}`: the cwd each pane will start in on the target (translated). */
  cwdByPaneKey: Record<string, string>
}

export type WorkingSetSessionTransferReason =
  | 'copied'
  | 'already-present'
  | 'not-transferable-agent'
  | 'invalid-session-id'
  | 'no-target-cwd'
  | 'source-missing'
  | 'source-too-large'
  | 'target-cwd-missing'
  | 'target-unreachable'
  /** A different file already holds that id on the target: it may be a live session there. */
  | 'target-conflict'
  | 'write-failed'
  | 'verify-failed'

export type WorkingSetSessionTransferFact = {
  /** `present` only after the copy was read back on the target. */
  transcript: 'present' | 'unknown'
  reason: WorkingSetSessionTransferReason
}

export type WorkingSetSessionTransferResult =
  | { status: 'transferred'; panes: Record<string, WorkingSetSessionTransferFact> }
  | { status: 'target-unavailable' }
  | { status: 'invalid-transfer-request'; field: 'connectionId' | 'cwdByPaneKey' }
  | Exclude<WorkingSetReadResult, { status: 'valid' }>
