/**
 * The terminal rail is chrome, not workspace state.
 *
 * Its width and collapsed flag sit with the other panel widths rather than in the per-workspace
 * session for a reason worth stating: a panel that changes width when you switch projects reads as
 * a bug, and per-workspace rail geometry would also mean a second project window writing rail state
 * into a session blob another window owns — the last-writer-wins shape this codebase already fenced
 * against. Global chrome preferences have neither problem.
 */

export const TERMINAL_RAIL_DEFAULT_WIDTH = 180
export const TERMINAL_RAIL_MIN_WIDTH = 132
export const TERMINAL_RAIL_MAX_WIDTH = 420

export function clampTerminalRailWidth(
  width: unknown,
  fallback = TERMINAL_RAIL_DEFAULT_WIDTH
): number {
  // Persisted widths can be stale, hand-edited, or arrive from a host running another version, so
  // a non-number is a fallback rather than a layout the user has to repair by hand.
  if (typeof width !== 'number' || !Number.isFinite(width)) {
    return fallback
  }
  return Math.min(TERMINAL_RAIL_MAX_WIDTH, Math.max(TERMINAL_RAIL_MIN_WIDTH, Math.round(width)))
}
