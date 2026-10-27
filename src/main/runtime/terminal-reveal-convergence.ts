import { createHash } from 'node:crypto'

/**
 * Whether a revealed pane shows what the main mirror holds.
 *
 * Content-free by construction: only row indices and truncated digests leave this module, never
 * terminal text. Three answers, never two — a read that failed is `unknown`, because reporting it
 * as an empty screen would make every unreadable pane look converged (or diverged) with nothing.
 */
export type RevealConvergenceVerdict =
  | { readonly verdict: 'converged'; readonly rows: number }
  | {
      readonly verdict: 'diverged'
      readonly rows: number
      readonly divergentRows: readonly number[]
      readonly mirrorDigest: string
      readonly rendererDigest: string
    }
  | {
      readonly verdict: 'unknown'
      readonly reason: 'mirror-unavailable' | 'renderer-unavailable' | 'moving'
    }

export type RevealConvergenceSample = { readonly lines: readonly string[] } | null

/** Bounded: a screen is a few dozen rows; anything above this is sampled from the top. */
export const REVEAL_CONVERGENCE_MAX_ROWS = 200
/** Long enough for a renderer that was merely behind to parse what it had already received. */
export const REVEAL_CONVERGENCE_RECHECK_MS = 400
/** A reveal settles (restore replay, remount, first fit) before the pane is judged. */
export const REVEAL_CONVERGENCE_SETTLE_MS = 750
const DIVERGENT_ROWS_REPORTED = 8

function rowDigest(line: string): string {
  return createHash('sha256').update(line.trimEnd()).digest('hex').slice(0, 12)
}

function screenDigest(rows: readonly string[]): string {
  const hash = createHash('sha256')
  for (const row of rows) {
    hash.update(rowDigest(row)).update('\n')
  }
  return hash.digest('hex').slice(0, 16)
}

/** Trailing blank rows carry no content either side can disagree about. */
function significantRows(lines: readonly string[]): string[] {
  const rows = lines.slice(0, REVEAL_CONVERGENCE_MAX_ROWS).map((line) => line.trimEnd())
  while (rows.length > 0 && rows.at(-1) === '') {
    rows.pop()
  }
  return rows
}

export function compareRevealConvergence(input: {
  readonly mirror: RevealConvergenceSample
  readonly renderer: RevealConvergenceSample
  /** The mirror's output sequence before and after the renderer was read. */
  readonly mirrorSequenceBefore: number
  readonly mirrorSequenceAfter: number
}): RevealConvergenceVerdict {
  if (!input.mirror) {
    return { verdict: 'unknown', reason: 'mirror-unavailable' }
  }
  if (!input.renderer) {
    return { verdict: 'unknown', reason: 'renderer-unavailable' }
  }
  // Output landed while the renderer was being read, so the two samples describe different moments.
  if (input.mirrorSequenceAfter !== input.mirrorSequenceBefore) {
    return { verdict: 'unknown', reason: 'moving' }
  }
  const mirrorRows = significantRows(input.mirror.lines)
  const rendererRows = significantRows(input.renderer.lines)
  const rows = Math.max(mirrorRows.length, rendererRows.length)
  const divergentRows: number[] = []
  for (let index = 0; index < rows; index++) {
    if ((mirrorRows[index] ?? '') !== (rendererRows[index] ?? '')) {
      divergentRows.push(index)
    }
  }
  if (divergentRows.length === 0) {
    return { verdict: 'converged', rows }
  }
  return {
    verdict: 'diverged',
    rows,
    divergentRows: divergentRows.slice(0, DIVERGENT_ROWS_REPORTED),
    mirrorDigest: screenDigest(mirrorRows),
    rendererDigest: screenDigest(rendererRows)
  }
}
