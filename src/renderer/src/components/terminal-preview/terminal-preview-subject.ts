/**
 * Which terminal a preview is about, resolved from the identity a rail row or tab actually holds.
 *
 * Rows are keyed by tab and leaf; the PTY is one lookup below that, and the live index is a separate
 * fact again. Keeping the two failure reasons apart is the point: a pane that has not spawned yet
 * and a terminal that has closed need opposite sentences, and a preview that renders both as an
 * empty frame is exactly the stale-looking-live failure this capability exists to prevent.
 *
 * Never falls back to another pane. A preview that retargets by convenience is how a user ends up
 * confidently reading the wrong terminal.
 */

export type TerminalPreviewSubject =
  | { status: 'available'; ptyId: string; tabId: string; leafId: string }
  | { status: 'unavailable'; reason: 'no-pty' | 'not-live' }

export function resolveTerminalPreviewSubject(args: {
  tabId: string
  leafId: string
  layoutsByTabId: Readonly<Record<string, { ptyIdsByLeafId?: Readonly<Record<string, string>> }>>
  /** The runtime's live PTY index, per tab. A pty absent from it is gone, not merely quiet. */
  ptyIdsByTabId: Readonly<Record<string, readonly string[]>>
}): TerminalPreviewSubject {
  const ptyId = args.layoutsByTabId[args.tabId]?.ptyIdsByLeafId?.[args.leafId]
  if (!ptyId) {
    return { status: 'unavailable', reason: 'no-pty' }
  }
  if (!(args.ptyIdsByTabId[args.tabId] ?? []).includes(ptyId)) {
    return { status: 'unavailable', reason: 'not-live' }
  }
  return { status: 'available', ptyId, tabId: args.tabId, leafId: args.leafId }
}
