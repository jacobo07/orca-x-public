/**
 * CHARACTERIZATION of the residual `terminal-render-progress.ts` names in its own docstring:
 * "a renderer that still reports a render while painting nothing".
 *
 * The Owner reported the frozen pane from a build that already contains `91a52e00e`
 * (`output-not-presented` and `isTerminalRenderProgressObservable` are both byte-present in the
 * running `app.asar`). So `onRender` firing is NOT sufficient evidence that pixels changed, and the
 * judge is blind here exactly as it was blind to the parse generation before `91a52e00e`: the same
 * defect, one stage further down the pipeline.
 *
 * Every assertion below states TODAY'S behaviour. When the paint signature lands they invert in
 * place, and the diff between the two revisions is the evidence that the gap was real.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  _resetWritePipelineHealthForTests,
  recordTerminalParseProgress
} from '@/lib/pane-manager/terminal-write-pipeline-health'
import {
  _resetVisiblePaneLivenessForTests,
  judgeVisiblePaneLiveness,
  registerVisiblePaneLiveness,
  type VisiblePaneLivenessEntry
} from './visible-pane-output-liveness'

/** A terminal that reports renders AND tracks what its canvas actually painted. The field state is
 *  `render()` advancing while `paint()` never does — a render loop that runs and lies. */
function makePaintingTerminal() {
  const listeners = new Set<() => void>()
  let paintedFrames = 0
  return {
    terminal: {
      onRender: (listener: () => void) => {
        listeners.add(listener)
        return { dispose: () => listeners.delete(listener) }
      }
    },
    render: () => {
      for (const listener of listeners) {
        listener()
      }
    },
    paint: () => {
      paintedFrames += 1
    },
    paintedFrames: () => paintedFrames
  }
}

type Harness = {
  entry: VisiblePaneLivenessEntry
  terminal: object
  render: () => void
  paint: () => void
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
  return {
    entry,
    terminal: fake.terminal,
    render: fake.render,
    paint: fake.paint,
    paintedFrames: fake.paintedFrames,
    state
  }
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
 *  service reported a frame. `paints` is the single variable these tests turn. */
function advance(pane: Harness, options: { paints: boolean }) {
  pane.state.model += 5
  pane.state.received += 100
  recordTerminalParseProgress(pane.terminal)
  pane.render()
  if (options.paints) {
    pane.paint()
  }
}

afterEach(() => {
  _resetVisiblePaneLivenessForTests()
  _resetWritePipelineHealthForTests()
})

describe('visible pane painted liveness (characterization)', () => {
  it('does not flag a pane whose render loop runs while its canvas paints nothing', () => {
    const pane = makePane()
    for (let i = 0; i < 8; i++) {
      advance(pane, { paints: false })
      // TODAY: no cause. The four upstream signals all advanced, so the judge has nothing left to
      // ask, and the pane stays frozen on screen for as long as the failure lasts. This is the
      // reported field symptom, and this empty array is the defect.
      expect(tick(pane)).toEqual([])
    }
    expect(pane.paintedFrames()).toBe(0)
  })

  it('does not flag a pane that paints every frame (control)', () => {
    const pane = makePane()
    for (let i = 0; i < 8; i++) {
      advance(pane, { paints: true })
      expect(tick(pane)).toEqual([])
    }
    expect(pane.paintedFrames()).toBe(8)
  })
})
