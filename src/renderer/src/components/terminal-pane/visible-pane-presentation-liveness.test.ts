import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  _resetWritePipelineHealthForTests,
  notifyUndeliverableWrite,
  recordTerminalParseProgress
} from '@/lib/pane-manager/terminal-write-pipeline-health'
import {
  _resetVisiblePaneLivenessForTests,
  judgeVisiblePaneLiveness,
  registerVisiblePaneLiveness,
  type VisiblePaneLivenessEntry
} from './visible-pane-output-liveness'

/** A terminal that reports renders, as xterm does. `render()` is the canvas painting a frame;
 *  withholding it is the freeze this file exists for. */
function makeRenderableTerminal() {
  const listeners = new Set<() => void>()
  return {
    terminal: {
      onRender: (listener: () => void) => {
        listeners.add(listener)
        return { dispose: () => listeners.delete(listener) }
      }
    },
    render: () => {
      for (const listener of [...listeners]) listener()
    },
    listenerCount: () => listeners.size
  }
}

type Harness = {
  entry: VisiblePaneLivenessEntry
  terminal: object
  render: () => void
  listenerCount: () => number
  unregister: () => void
  state: { ptyId: string | null; onScreen: boolean; received: number; model: number }
}

function makePane(options: { renderable?: boolean; ptyId?: string } = {}): Harness {
  const renderable = options.renderable ?? true
  const fake = makeRenderableTerminal()
  const terminal: object = renderable ? fake.terminal : {}
  const state = {
    ptyId: (options.ptyId ?? 'pty-1') as string | null,
    onScreen: true,
    received: 0,
    model: 1
  }
  const entry: VisiblePaneLivenessEntry = {
    terminal,
    getPtyId: () => state.ptyId,
    isOnScreen: () => state.onScreen,
    requestRecovery: vi.fn()
  }
  const unregister = registerVisiblePaneLiveness(entry)
  return {
    entry,
    terminal,
    render: fake.render,
    listenerCount: fake.listenerCount,
    unregister,
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

/** One healthy interval: main advanced, bytes arrived, xterm parsed them. `present` is whether the
 *  canvas then painted — the single variable these tests turn. */
function advance(pane: Harness, options: { present: boolean }) {
  pane.state.model += 5
  pane.state.received += 100
  recordTerminalParseProgress(pane.terminal)
  if (options.present) {
    pane.render()
  }
}

afterEach(() => {
  _resetVisiblePaneLivenessForTests()
})

describe('visible pane presentation liveness', () => {
  it('flags a pane that keeps parsing while its canvas stops presenting', () => {
    const pane = makePane()
    advance(pane, { present: true })
    expect(tick(pane)).toEqual([])

    advance(pane, { present: false })
    expect(tick(pane)).toEqual([])
    advance(pane, { present: false })

    const verdicts = tick(pane)
    expect(verdicts).toHaveLength(1)
    expect(verdicts[0]).toMatchObject({ ptyId: 'pty-1', cause: 'output-not-presented' })
  })

  it('never flags a pane that parses and presents (negative control)', () => {
    const pane = makePane()
    for (let i = 0; i < 6; i++) {
      advance(pane, { present: true })
      expect(tick(pane)).toEqual([])
    }
  })

  it('never judges presentation on a terminal that reports no renders at all', () => {
    // The web client and every pre-existing fixture pass such a terminal. Judging it would read
    // each healthy parsed tick as a frozen canvas and remount forever.
    const pane = makePane({ renderable: false })
    for (let i = 0; i < 6; i++) {
      advance(pane, { present: false })
      expect(tick(pane)).toEqual([])
    }
  })

  it('a single painted frame resets the streak', () => {
    const pane = makePane()
    advance(pane, { present: true })
    tick(pane)
    advance(pane, { present: false })
    expect(tick(pane)).toEqual([])
    advance(pane, { present: true })
    expect(tick(pane)).toEqual([])
    advance(pane, { present: false })
    expect(tick(pane)).toEqual([])
  })

  it('does not flag a presenting pane whose PTY is idle', () => {
    const pane = makePane()
    advance(pane, { present: true })
    tick(pane)
    for (let i = 0; i < 5; i++) {
      expect(tick(pane)).toEqual([])
    }
  })

  it('keeps delivery causes ahead of presentation: bytes received but never parsed', () => {
    const pane = makePane()
    advance(pane, { present: true })
    tick(pane)
    for (let i = 0; i < 2; i++) {
      pane.state.model += 5
      pane.state.received += 100
    }
    tick(pane)
    pane.state.model += 5
    pane.state.received += 100
    expect(tick(pane)).toEqual([expect.objectContaining({ cause: 'output-not-parsed' })])
  })

  it('keeps a certified-dead pipeline ahead of presentation', () => {
    const pane = makePane()
    advance(pane, { present: true })
    tick(pane)
    notifyUndeliverableWrite(pane.terminal, 'write-stalled')
    advance(pane, { present: false })
    expect(tick(pane)).toEqual([])
    advance(pane, { present: false })
    expect(tick(pane)).toEqual([expect.objectContaining({ cause: 'pipeline-dead' })])
    _resetWritePipelineHealthForTests(pane.terminal)
  })

  it('releases its render subscription when the pane unregisters', () => {
    const pane = makePane()
    expect(pane.listenerCount()).toBe(1)
    pane.unregister()
    expect(pane.listenerCount()).toBe(0)
  })
})
