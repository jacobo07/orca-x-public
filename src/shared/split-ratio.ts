/**
 * A split node's ratio is the flex basis of its first child, and both split trees — terminal panes
 * and tab groups — document the same fallback: absent means an even split.
 *
 * The persisted value is unbounded by the session schema, so it can arrive non-finite, negative or
 * far outside the range from a hand edit, a partially-written file, or a host on another version.
 * A ratio at or beyond either end resolves to a zero or negative flex basis, which collapses one
 * pane to nothing — read by the user as the terminal having vanished rather than as a bad number,
 * and repairable only by hand-editing the profile.
 *
 * Only the genuinely unusable is repaired. A 50px pane on a wide monitor is a legitimately tiny
 * ratio, so clamping "unusual" values into a comfortable band would move a layout the user
 * actually dragged.
 */

export const EVEN_SPLIT_RATIO = 0.5

export function isUsableSplitRatio(ratio: unknown): ratio is number {
  return typeof ratio === 'number' && Number.isFinite(ratio) && ratio > 0 && ratio < 1
}

/** Returns undefined for an unusable ratio, which every reader resolves to EVEN_SPLIT_RATIO. */
export function normalizeSplitRatio(ratio: unknown): number | undefined {
  return isUsableSplitRatio(ratio) ? ratio : undefined
}
