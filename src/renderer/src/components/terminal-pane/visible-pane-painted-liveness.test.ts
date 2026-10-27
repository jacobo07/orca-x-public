/**
 * The residual `terminal-render-progress.ts` names in its own docstring: "a renderer that still
 * reports a render while painting nothing".
 *
 * The Owner reported the frozen pane from a build that already contains `91a52e00e`
 * (`output-not-presented` and `isTerminalRenderProgressObservable` are both byte-present in the
 * running `app.asar`). So `onRender` firing is NOT evidence that pixels changed, and the judge was
 * blind here exactly as it was blind to the parse generation before `91a52e00e`: the same defect,
 * one stage further down the pipeline.
 *
 * The fixture models `preserveDrawingBuffer: false`, which is how Orca creates its WebGL addon: the
 * canvas reads back its drawn frame only inside the render callback, and a cleared buffer anywhere
 * else. The first implementation sampled on the watchdog tick; against a real canvas it hashed a
 * cleared buffer every time and would have flagged every healthy pane. A fixture whose canvas read
 * back correctly at any moment could not see that, so this one does not.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  _resetWritePipelineHealthForTests,
  recordTerminalParseProgress
} from '@/lib/pane-manager/terminal-write-pipeline-health'
import {
  _resetTerminalPaintProgressForTests,
  _setTerminalPaintSamplerForTests
} from './terminal-paint-progress'
import {
  _resetVisiblePaneLivenessForTests,
  judgeVisiblePaneLiveness,
  registerVisiblePaneLiveness,
  type VisiblePaneLivenessEntry
} from './visible-pane-output-liveness'

type PaintState = { frames: number; judgeable: boolean; drawing: boolean }
const paintStateByTerminal = new WeakMap<object, PaintState>()

/** Reads what a non-preserved WebGL canvas would: the drawn frame inside the render callback, a
 *  cleared buffer outside it. `null` is the unjudgeable case the real sampler returns for a paused
 *  renderer, a scrolled-back viewport, or no reachable canvas at all. */
function readLikeANonPreservedCanvas(terminal: object): string | null {
  const state = paintStateByTerminal.get(terminal)
  if (!state || !state.judgeable) {
    return null
  }
  return state.drawing ? `frame-${state.frames}` : 'cleared-buffer'
}

/** A terminal that reports renders AND tracks what its canvas actually drew. The field state is
 *  `render()` advancing while `paint()` never does — a render loop that runs and lies. */
function makePaintingTerminal() {
  const listeners = new Set<() => void>()
  const terminal = {
    onRender: (listener: () => void) => {
      listeners.add(listener)
      return { dispose: () => listeners.delete(listener) }
    }
  }
  const state: PaintState = { frames: 0, judgeable: true, drawing: false }
  paintStateByTerminal.set(terminal, state)
  return {
    terminal,
    render: () => {
      state.drawing = true
      try {
        for (const listener of listeners) {
          listener()
        }
      } finally {
        state.drawing = false
      }
    },
    paint: () => {
      state.frames += 1
    },
    setJudgeable: (judgeable: boolean) => {
      state.judgeable = judgeable
    },
    paintedFrames: () => state.frames
  }
}

type Harness = {
  entry: VisiblePaneLivenessEntry
  terminal: object
  render: () => void
  paint: () => void
  setJudgeable: (judgeable: boolean) => void
  paintedFrames: () => number
  state: { ptyId: string | null; onScreen: boolean; received: number; model: number }
}

function makePane(ptyId = 'pty-1'): Harness {
  const fake = makePaintingTerminal()
  const state = { ptyId: ptyId as string | null, onScreen: true, received: 0, model: 1 }
  const entry: VisiblePaneLivenessEntry = {
    terminal: fake.terminal,
    getPtyId: () => state.ptyId,
    isOnScreen: () => state.onScreen,
    requestRecovery: vi.fn()
  }
  registerVisiblePaneLiveness(entry)
  // `fake` already carries `terminal`; naming it again here would be overwritten by the spread.
  return { entry, ...fake, state }
}

function tick(pane: Harness) {
  const ptyId = pane.state.ptyId ?? ''
  return judgeVisiblePaneLiveness({
    modelOutputSequenceByPty: { [ptyId]: pane.state.model },
    hiddenGatedPtyIds: [],
    getReceivedChars: () => pane.state.received,
    stallTicksToRecover: 2
  })
}

/** One healthy interval up to the canvas: main advanced, bytes arrived, xterm parsed, the render
 *  service drew (or did not) and then reported a frame. `paints` is the variable these tests turn. */
function advance(pane: Harness, options: { paints: boolean }) {
  pane.state.model += 5
  pane.state.received += 100
  recordTerminalParseProgress(pane.terminal)
  if (options.paints) {
    pane.paint()
  }
  pane.render()
}

beforeEach(() => {
  _setTerminalPaintSamplerForTests(readLikeANonPreservedCanvas)
})

afterEach(() => {
  _resetVisiblePaneLivenessForTests()
  _resetWritePipelineHealthForTests()
  _resetTerminalPaintProgressForTests()
})

describe('visible pane painted liveness', () => {
  it('flags a pane whose render loop runs while its canvas paints nothing', () => {
    const pane = makePane()
    advance(pane, { paints: false })
    expect(tick(pane)).toEqual([])
    advance(pane, { paints: false })
    expect(tick(pane)).toEqual([])
    advance(pane, { paints: false })

    const verdicts = tick(pane)
    expect(verdicts).toHaveLength(1)
    expect(verdicts[0]).toMatchObject({ ptyId: 'pty-1', cause: 'output-not-painted' })
    expect(pane.paintedFrames()).toBe(0)
  })

  it('never flags a pane that paints every frame (control)', () => {
    // Also the timing control: a sampler that read on the tick instead of inside the frame would
    // see the cleared buffer every time here, and flag this healthy pane.
    const pane = makePane()
    for (let i = 0; i < 8; i++) {
      advance(pane, { paints: true })
      expect(tick(pane)).toEqual([])
    }
    expect(pane.paintedFrames()).toBe(8)
  })

  it('never judges pixels it is not entitled to judge', () => {
    // The real sampler returns null for a paused renderer, a scrolled-back viewport and the web
    // client's canvas-less terminal. In all three not painting is CORRECT, so an unchanged canvas
    // must stay unknown rather than become a remount.
    const pane = makePane()
    pane.setJudgeable(false)
    for (let i = 0; i < 8; i++) {
      advance(pane, { paints: false })
      expect(tick(pane)).toEqual([])
    }
  })

  it('does not accumulate a stall across a quiet tick that produced nothing to paint', () => {
    const pane = makePane()
    advance(pane, { paints: false })
    expect(tick(pane)).toEqual([])
    advance(pane, { paints: false })
    expect(tick(pane)).toEqual([])

    // A tick with no model progress: nothing was produced, so an unchanged canvas is correct and
    // the streak must reset rather than carry into a remount.
    expect(tick(pane)).toEqual([])
    advance(pane, { paints: false })
    expect(tick(pane)).toEqual([])
  })

  it('still flags the render loop stopping, which outranks paint', () => {
    const pane = makePane()
    for (let i = 0; i < 3; i++) {
      pane.state.model += 5
      pane.state.received += 100
      recordTerminalParseProgress(pane.terminal)
      // No render() and no paint(): onRender is the more specific cause and must win.
    }
    pane.state.model += 5
    pane.state.received += 100
    recordTerminalParseProgress(pane.terminal)
    expect(tick(pane)).toEqual([])
    pane.state.model += 5
    pane.state.received += 100
    recordTerminalParseProgress(pane.terminal)
    expect(tick(pane)).toEqual([])
    pane.state.model += 5
    pane.state.received += 100
    recordTerminalParseProgress(pane.terminal)

    const verdicts = tick(pane)
    expect(verdicts).toHaveLength(1)
    expect(verdicts[0]).toMatchObject({ cause: 'output-not-presented' })
  })
})
