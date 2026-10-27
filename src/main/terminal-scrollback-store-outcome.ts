/**
 * Why a scrollback buffer did or did not reach disk.
 *
 * The persistence counterpart to shared/terminal-snapshot-unavailability.ts, which answers the same
 * shape of question for the live wire ("why did the host hand me no buffer"). This one answers "why
 * is there no stored blob", and the two must stay distinct: a pane the host could not serialize now
 * and a pane whose bytes a full disk rejected need different words and different user actions.
 *
 * The distinction that matters most is between 'nothing-to-store' and 'not-stored'. Both once
 * returned null, so a caller could not tell "there was no scrollback" from "your scrollback could
 * not be saved" — and the session file published without the ref either way, reporting success.
 */

import type { DurablePublishStage } from './durable-file-write'

export const TERMINAL_SCROLLBACK_STORE_FAILURES = [
  // The volume (or the user's quota on it) has no room. Actionable: free space, then retry.
  'storage-full',
  // The filesystem refuses writes outright — a read-only mount, not a permission on this path.
  'read-only',
  'permission-denied',
  // The directory the snapshot lives in is gone or is not a directory.
  'storage-unavailable',
  'unknown-io'
] as const

export type TerminalScrollbackStoreFailure = (typeof TERMINAL_SCROLLBACK_STORE_FAILURES)[number]

export type TerminalScrollbackStoreOutcome =
  | { status: 'stored'; ref: string }
  /** There was genuinely nothing to persist — an empty buffer, or no configured snapshot root. */
  | { status: 'nothing-to-store' }
  | {
      status: 'not-stored'
      failure: TerminalScrollbackStoreFailure
      /** The OS code verbatim, so a diagnostic is never limited to the taxonomy above. */
      code: string | null
      /** Which step failed, when a durable publisher named one. */
      stage: DurablePublishStage | null
    }

/**
 * Map an OS error code onto the failure a caller can act on. Anything unrecognised stays
 * 'unknown-io' rather than being folded into the nearest neighbour: a wrong specific answer sends
 * someone to fix the wrong thing, which is worse than an honest "we do not know".
 */
export function classifyScrollbackStoreFailure(
  code: string | null
): TerminalScrollbackStoreFailure {
  switch (code) {
    // EDQUOT is the same sentence to the user as ENOSPC: there is no room for these bytes.
    case 'ENOSPC':
    case 'EDQUOT':
      return 'storage-full'
    case 'EROFS':
      return 'read-only'
    case 'EACCES':
    case 'EPERM':
      return 'permission-denied'
    case 'ENOENT':
    case 'ENOTDIR':
      return 'storage-unavailable'
    default:
      return 'unknown-io'
  }
}
