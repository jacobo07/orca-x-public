import type { HistoryRecoveryFreeze } from './terminal-history-recovery-quarantine'

export type OpenSessionOptions = {
  cwd: string
  cols: number
  rows: number
  recoveryFreeze?: HistoryRecoveryFreeze
  quarantineUnreadableRecovery?: boolean
}

export type HistoryManagerOptions = {
  onWriteError?: (sessionId: string, error: Error) => void
  checkpointMaxBytes?: number
}

/**
 * 'unavailable' means there is no checkpointing for this session — it was never set up, or it was
 * switched off. 'failed' means we tried and the bytes did not land. Those were one value until a
 * full disk proved the difference: the write threw, the manager reported 'unavailable', and the
 * adapter read that as "nothing to do" and cleared the session's retry flags.
 */
export type HistoryCheckpointResult = 'committed' | 'retryable' | 'unavailable' | 'failed'

/**
 * Did the checkpoint fail to reach disk? The adapter's flag-clearing sites ask this, not "may we
 * retry" — 'retryable' and 'failed' differ in their prognosis and agree on the only fact those
 * sites use: nothing landed, so the session is still dirty and 'done' would be a lie.
 */
export function checkpointDidNotLand(result: HistoryCheckpointResult): boolean {
  return result === 'retryable' || result === 'failed'
}
