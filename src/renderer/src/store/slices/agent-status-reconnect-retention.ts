import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { SshConnectionStatus } from '../../../../shared/ssh-types'

// Why: 'connected' is included because the transport-loss clear can reach the renderer before the
// state event does; the terminal state that follows then clears the rows (see ssh.ts).
export const CONNECTION_STATUSES_THAT_RETAIN_ROWS: readonly SshConnectionStatus[] = [
  'connected',
  'connecting',
  'deploying-relay',
  'reconnecting'
]

/** Unknown connection state clears: an unverifiable row must not outlive proof that it is reachable. */
export function shouldRetainRowsOnConnectionLoss(status: SshConnectionStatus | undefined): boolean {
  return status !== undefined && CONNECTION_STATUSES_THAT_RETAIN_ROWS.includes(status)
}

/**
 * Keep the row but make freshness gates treat it as unverified until a live hook replays.
 * Why: `restoredUnconfirmed` is the existing "no live event since" expression, cleared by any accepted event.
 * Returns the same reference when nothing changes (a `done` row has no turn left to doubt).
 */
export function markRowUnverified(entry: AgentStatusEntry): AgentStatusEntry {
  if (entry.state === 'done' || entry.restoredUnconfirmed === true) {
    return entry
  }
  return { ...entry, restoredUnconfirmed: true }
}
