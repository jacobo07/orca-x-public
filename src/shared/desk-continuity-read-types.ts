import type { DeskProjection } from './desk-continuity-projection'

/** What the continuity read answers. A client with no desktop store says so; it never answers an empty desk. */
export type DeskReadResult =
  | { status: 'loaded'; projection: DeskProjection; readAt: number }
  | { status: 'unavailable' }

/** A pane is named by where it lives on the desk, never by a path or a session id. */
export type PanePreviewRequest = { hostId: string; tabId: string; leafId: string | null }

export type PanePreviewSourceKind = 'session-ref' | 'daemon-history'

/**
 * A pane's last recorded screen. It is always a snapshot, never live output, so a surface must not
 * present it as live. Each non-rendered state needs a different sentence:
 * - `none`: nothing was ever recorded;
 * - `unreadable`: something was recorded and could not be read back;
 * - `not-found`: the desk no longer has this pane.
 */
export type PanePreviewResult =
  | {
      status: 'rendered'
      source: PanePreviewSourceKind
      lines: string[]
      cols: number
      rows: number
    }
  | { status: 'none' }
  | { status: 'unreadable'; source: PanePreviewSourceKind }
  | { status: 'not-found' }
  | { status: 'invalid-request' }
  | { status: 'unavailable' }
