/**
 * A pane the user is looking at must advance when main's model of its PTY
 * advances. The hover preview reads that model, so the field symptom was a
 * live preview beside a frozen pane: bytes gated as hidden, lost in delivery,
 * discarded by a certified-dead write pipeline whose one-shot recovery never
 * landed, parsed by an xterm whose canvas had stopped presenting, or presented
 * by a render loop that painted nothing. None of those leaves ACK-starved
 * in-flight bytes, so the push watchdog was blind to all five. This judge
 * compares the two sides per on-screen pane on the watchdog's existing tick and
 * asks for a remount, which rebuilds the xterm, re-syncs the hidden gate and
 * restores from the model.
 *
 * The judge owns FOUR progress signals because each one proved, in turn, to sit
 * upstream of the failure it was meant to see:
 *   received   -- bytes reached the renderer
 *   parse      -- xterm consumed them (credited from write callbacks, including
 *                 an empty FIFO probe, so it advances upstream of the renderer)
 *   render     -- xterm's render service reported a frame (`onRender`)
 *   paint      -- the pixels drawn in that frame actually changed
 *
 * Each was added because the one before it returned "healthy" for a pane the
 * user could see was frozen.
 */
import {
  captureTerminalParseProgressGeneration,
  isTerminalWritePipelineCertifiedDead
} from '@/lib/pane-manager/terminal-write-pipeline-health'
import {
  recordTerminalFrameDrawn,
  startTerminalPaintObservation,
  takeTerminalPaintSample
} from './terminal-paint-progress'
import {
  captureTerminalRenderProgressGeneration,
  isTerminalRenderProgressObservable,
  observeTerminalRenderProgress
} from './terminal-render-progress'

export type VisiblePaneStallCause =
  | 'pipeline-dead'
  | 'output-not-received'
  | 'output-not-parsed'
  | 'output-not-presented'
  | 'output-not-painted'

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
  renderGeneration: number
  /** null means no judgeable frame was sampled since the last tick, never that pixels froze. */
  paintSignature: string | null
  stallTicks: number
}

const entries = new Set<VisiblePaneLivenessEntry>()
const observations = new WeakMap<VisiblePaneLivenessEntry, Observation>()
const renderSubscriptions = new WeakMap<VisiblePaneLivenessEntry, () => void>()

export function registerVisiblePaneLiveness(entry: VisiblePaneLivenessEntry): () => void {
  entries.add(entry)
  // Why here and not at the pane: this judge is the only consumer of render and paint progress,
  // and owning the subscriptions keeps the entry contract — and pty-connection.ts — unchanged.
  const disposePaint = startTerminalPaintObservation(entry.terminal)
  const disposeRender = observeTerminalRenderProgress(entry.terminal, () =>
    recordTerminalFrameDrawn(entry.terminal)
  )
  renderSubscriptions.set(entry, () => {
    disposeRender()
    disposePaint()
  })
  return () => {
    entries.delete(entry)
    observations.delete(entry)
    renderSubscriptions.get(entry)?.()
    renderSubscriptions.delete(entry)
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

/** One observation per tick. Recovery needs CONSECUTIVE ticks in which the
 *  model advanced and the pane did not; a quiet tick or any pane-side progress
 *  resets the streak, so sparse healthy updates never accumulate. Unknown
 *  model progress (no sequence) or an off-screen pane forgets the observation. */
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
    const renderGeneration = captureTerminalRenderProgressGeneration(entry.terminal)
    // Taken every tick, so each comparison is between two frames drawn in consecutive windows.
    const paintSignature = takeTerminalPaintSample(entry.terminal)
    const previous = observations.get(entry)
    if (!previous || previous.ptyId !== ptyId) {
      observations.set(entry, {
        ptyId,
        modelSequence,
        receivedChars,
        parseGeneration,
        renderGeneration,
        paintSignature,
        stallTicks: 0
      })
      continue
    }
    const parsed = parseGeneration !== previous.parseGeneration
    const presented = renderGeneration !== previous.renderGeneration
    const modelAdvanced = modelSequence > previous.modelSequence
    const paintStalled =
      modelAdvanced &&
      paintSignature !== null &&
      previous.paintSignature !== null &&
      paintSignature === previous.paintSignature
    // Why dead first: a dead pipeline still receives (and credits) bytes it discards.
    // Why parse outranks receive: parsing bytes received before the last tick is progress.
    // Why presentation is judged only when observable: a terminal with no `onRender` never advances
    // a render generation, so judging it would read every healthy parsed tick as a frozen canvas.
    // Why paint is last: it is the only signal that survives a render loop reporting frames it
    // never painted, and it is unjudgeable whenever not painting is the correct behaviour.
    const cause: VisiblePaneStallCause | null = isTerminalWritePipelineCertifiedDead(entry.terminal)
      ? 'pipeline-dead'
      : !parsed
        ? receivedChars === previous.receivedChars
          ? 'output-not-received'
          : 'output-not-parsed'
        : isTerminalRenderProgressObservable(entry.terminal) && !presented
          ? 'output-not-presented'
          : paintStalled
            ? 'output-not-painted'
            : null
    let stallTicks = cause !== null && modelAdvanced ? previous.stallTicks + 1 : 0
    if (stallTicks >= args.stallTicksToRecover && cause !== null) {
      verdicts.push({ entry, ptyId, cause, hiddenGated: gated.has(ptyId) })
      stallTicks = 0
    }
    observations.set(entry, {
      ptyId,
      modelSequence,
      receivedChars,
      parseGeneration,
      renderGeneration,
      paintSignature,
      stallTicks
    })
  }
  return verdicts
}

export function hasVisiblePaneLivenessEntries(): boolean {
  return entries.size > 0
}

export function _resetVisiblePaneLivenessForTests(): void {
  entries.clear()
}
