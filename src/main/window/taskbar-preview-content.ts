/**
 * Which rows of a terminal go into a thumbnail 250 pixels wide.
 *
 * A taskbar thumbnail cannot show an 120x30 grid legibly, so something has to be dropped, and the
 * only question worth answering is which part the user is actually looking for. They are checking
 * on work in progress, so the answer is the most recent rows — the prompt, the progress line, the
 * error that just landed.
 *
 * Trailing blank rows are dropped first, and that is not cosmetic. A terminal that has produced
 * three lines keeps them at the *top* of its viewport with blank rows below, so taking "the last N
 * rows" without trimming samples empty space and reports a working terminal as an empty one.
 *
 * Row count is derived from the height the shell asked for, never chosen. Asking for more rows than
 * fit legibly produces a grey smear that says less than four readable lines would.
 */

/** Below this, glyphs stop resolving into words and the thumbnail says nothing. */
export const DEFAULT_MIN_ROW_HEIGHT_PX = 11

/**
 * A generous ceiling on characters handed to the rasterizer. The bitmap clips anyway; this only
 * stops a single pathological line (a minified bundle, a base64 blob) from costing a long draw.
 */
export const MAX_THUMBNAIL_COLUMNS = 512

export type ThumbnailLineSelection = {
  lines: string[]
  /** Rows the height could hold, before content ran out. Reported so callers can measure fit. */
  capacity: number
}

export function selectThumbnailLines(args: {
  /** The terminal viewport, top row first, as the headless emulator holds it. */
  viewportLines: readonly string[]
  /** Height in pixels the shell asked for. */
  requestedHeight: number
  minRowHeightPx?: number
  maxColumns?: number
}): ThumbnailLineSelection {
  const minRowHeight = args.minRowHeightPx ?? DEFAULT_MIN_ROW_HEIGHT_PX
  const maxColumns = args.maxColumns ?? MAX_THUMBNAIL_COLUMNS
  const capacity =
    minRowHeight > 0 && args.requestedHeight > 0
      ? Math.max(1, Math.floor(args.requestedHeight / minRowHeight))
      : 1

  let end = args.viewportLines.length
  while (end > 0 && args.viewportLines[end - 1]?.trim() === '') {
    end -= 1
  }

  // Everything blank is a real state — a cleared screen — and showing the top of it is truthful.
  // Reporting no rows at all would make the caller unable to tell it from having no terminal.
  const start = end === 0 ? 0 : Math.max(0, end - capacity)
  const sliceEnd = end === 0 ? Math.min(capacity, args.viewportLines.length) : end

  const lines = args.viewportLines.slice(start, sliceEnd).map((line) => {
    const trimmed = line.replace(/\s+$/, '')
    return trimmed.length > maxColumns ? trimmed.slice(0, maxColumns) : trimmed
  })

  return { lines, capacity }
}

/**
 * What the thumbnail says when there is no terminal to show.
 *
 * Deliberately words rather than a blank frame: the reasons a preview has nothing to show are
 * different from each other, and an empty rectangle reports all of them as the same thing — which
 * is indistinguishable from the feature being broken.
 */
export function describeUnavailableSubject(
  reason: 'no-workspace' | 'no-tab' | 'no-pane' | 'no-pty' | 'not-live'
): string[] {
  switch (reason) {
    case 'no-workspace':
      return ['Orca', 'No project open']
    case 'no-tab':
    case 'no-pane':
      return ['Orca', 'No terminal open']
    case 'no-pty':
      return ['Orca', 'Terminal starting...']
    case 'not-live':
      return ['Orca', 'Terminal closed']
  }
}
