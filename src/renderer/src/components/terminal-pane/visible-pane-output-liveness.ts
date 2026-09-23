/**
 * A pane the user is looking at must advance when main's model of its PTY
 * advances. The hover preview reads that model, so the field symptom was a
 * live preview beside a frozen pane: bytes gated as hidden, lost in delivery,
 * or discarded by a certified-dead write pipeline whose one-shot recovery never
 * landed. None of those leaves ACK-starved in-flight bytes, so the push
 * watchdog was blind to all three. This judge compares the two sides per
 * on-screen pane on the watchdog's existing tick and asks for a remount, which
 * rebuilds the xterm, re-syncs the hidden gate and restores from the model.
 */
import {
  captureTerminalParseProgressGeneration,
  isTerminalWritePipelineCertifiedDead
} from '@/lib/pane-manager/terminal-write-pipeline-health'

export type VisiblePaneStallCause = 'pipeline-dead' | 'output-not-received' | 'output-not-parsed'

export type VisiblePaneLivenessEntry = {
  terminal: object
  getPtyId: () => string | null
  /** True only while the pane itself expects foreground bytes. */
  isOnScreen: () => boolean
  requestRecovery: (cause: VisiblePaneStallCause) => void
}

export type VisiblePaneStallVerdict = {
  entry: VisiblePaneLivenessEntry
  ptyId: string
  cause: VisiblePaneStallCause
  hiddenGated: boolean
}

type Observation = {
  ptyId: string
  modelSequence: number
  receivedChars: number
  parseGeneration: number
  stallTicks: number
}

const entries = new Set<VisiblePaneLivenessEntry>()
const observations = new WeakMap<VisiblePaneLivenessEntry, Observation>()

export function registerVisiblePaneLiveness(entry: VisiblePaneLivenessEntry): () => void {
  entries.add(entry)
  return () => {
    entries.delete(entry)
    observations.delete(entry)
  }
}

export function collectOnScreenPtyIds(): string[] {
  const ids = new Set<string>()
  for (const entry of entries) {
    const ptyId = entry.getPtyId()
    if (ptyId && entry.isOnScreen()) {
      ids.add(ptyId)
    }
  }
  return [...ids]
}

/** One observation per tick. A stall tick needs the model to advance while the
 *  pane did not; any pane progress resets the streak. Unknown model progress
 *  (no sequence) or an off-screen pane forgets the observation. */
export function judgeVisiblePaneLiveness(args: {
  modelOutputSequenceByPty: Record<string, number> | undefined
  hiddenGatedPtyIds: readonly string[] | undefined
  getReceivedChars: (ptyId: string) => number
  stallTicksToRecover: number
}): VisiblePaneStallVerdict[] {
  const verdicts: VisiblePaneStallVerdict[] = []
  const gated = new Set(args.hiddenGatedPtyIds ?? [])
  for (const entry of entries) {
    const ptyId = entry.getPtyId()
    const modelSequence = ptyId ? args.modelOutputSequenceByPty?.[ptyId] : undefined
    if (!ptyId || !entry.isOnScreen() || typeof modelSequence !== 'number') {
      observations.delete(entry)
      continue
    }
    const receivedChars = args.getReceivedChars(ptyId)
    const parseGeneration = captureTerminalParseProgressGeneration(entry.terminal)
    const previous = observations.get(entry)
    if (!previous || previous.ptyId !== ptyId) {
      observations.set(entry, {
        ptyId,
        modelSequence,
        receivedChars,
        parseGeneration,
        stallTicks: 0
      })
      continue
    }
    // Why dead first: a dead pipeline still receives (and credits) bytes it discards.
    const cause: VisiblePaneStallCause | null = isTerminalWritePipelineCertifiedDead(entry.terminal)
      ? 'pipeline-dead'
      : receivedChars === previous.receivedChars
        ? 'output-not-received'
        : parseGeneration === previous.parseGeneration
          ? 'output-not-parsed'
          : null
    let stallTicks = previous.stallTicks
    if (cause === null) {
      stallTicks = 0
    } else if (modelSequence > previous.modelSequence) {
      stallTicks += 1
    }
    if (stallTicks >= args.stallTicksToRecover && cause !== null) {
      verdicts.push({ entry, ptyId, cause, hiddenGated: gated.has(ptyId) })
      stallTicks = 0
    }
    observations.set(entry, { ptyId, modelSequence, receivedChars, parseGeneration, stallTicks })
  }
  return verdicts
}

export function hasVisiblePaneLivenessEntries(): boolean {
  return entries.size > 0
}

export function _resetVisiblePaneLivenessForTests(): void {
  entries.clear()
}
