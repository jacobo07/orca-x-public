/**
 * Whether a terminal is still PRESENTING, as distinct from whether it is still parsing.
 *
 * `terminal-write-pipeline-health.ts` counts parse progress from xterm write callbacks —
 * including an empty FIFO probe whose stated purpose is to prove the parser is alive. That
 * generation therefore advances entirely upstream of the renderer. So a pane whose canvas stopped
 * presenting while xterm kept parsing was invisible to the delivery judge: it read `parsed === true`
 * and returned no cause at all, for as long as the pane stayed frozen. Meanwhile the hover preview
 * reads main's headless model, which is healthy — which is exactly the reported field symptom, a
 * frozen pane beside a live preview.
 *
 * xterm fires `onRender` when its render service paints rows, so counting that gives the judge a
 * second generation that is independent of the write pipeline.
 *
 * WHAT THIS DOES NOT COVER: a renderer that still reports a render while painting nothing — a
 * corrupt shared glyph atlas is the known example of that class. This detects a render loop that
 * STOPPED, never one that lies, and anything keyed on `onRender` inherits that limit.
 */

/** Structural, because the judge holds its subject as `object`: the web client and the unit
 *  fixtures pass terminals that expose no renderer at all. */
type RenderProgressSubscribable = {
  onRender?: (listener: () => void) => { dispose?: () => void } | void
}

const renderGenerationByTerminal = new WeakMap<object, number>()
/** Presence here is the ONLY licence to judge presentation. A terminal with no `onRender` never
 *  advances a generation, so judging it would read every parsed tick as a frozen canvas and
 *  remount healthy panes forever. Absent means unknown, and unknown is not a stall. */
const observedTerminals = new WeakSet<object>()

export function recordTerminalRenderProgress(terminal: object): void {
  renderGenerationByTerminal.set(terminal, (renderGenerationByTerminal.get(terminal) ?? 0) + 1)
}

export function captureTerminalRenderProgressGeneration(terminal: object): number {
  return renderGenerationByTerminal.get(terminal) ?? 0
}

/** True only once a real `onRender` subscription landed for this terminal. */
export function isTerminalRenderProgressObservable(terminal: object): boolean {
  return observedTerminals.has(terminal)
}

/**
 * Subscribe to the terminal's render notifications. Returns a disposer; safe to call on a terminal
 * that exposes no `onRender`, in which case nothing is observed and the terminal stays unjudgeable
 * for presentation.
 */
export function observeTerminalRenderProgress(terminal: object): () => void {
  const subscribe = (terminal as RenderProgressSubscribable).onRender
  if (typeof subscribe !== 'function') {
    return () => {}
  }
  let subscription: { dispose?: () => void } | void
  try {
    subscription = subscribe.call(terminal, () => {
      recordTerminalRenderProgress(terminal)
    })
  } catch {
    // Why swallowed: presentation liveness is a diagnostic lane. A terminal whose renderer refuses
    // subscription must degrade to today's behaviour, never take down pane construction.
    return () => {}
  }
  observedTerminals.add(terminal)
  renderGenerationByTerminal.set(terminal, captureTerminalRenderProgressGeneration(terminal))
  return () => {
    observedTerminals.delete(terminal)
    try {
      subscription?.dispose?.()
    } catch {
      // Disposal races a torn-down renderer; the WeakSet delete above is what matters.
    }
  }
}

export function _resetTerminalRenderProgressForTests(terminal: object): void {
  renderGenerationByTerminal.delete(terminal)
  observedTerminals.delete(terminal)
}
