import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  _resetWritePipelineHealthForTests,
  notifyUndeliverableWrite,
  recordTerminalParseProgress
} from '@/lib/pane-manager/terminal-write-pipeline-health'
import {
  _resetVisiblePaneLivenessForTests,
  collectOnScreenPtyIds,
  judgeVisiblePaneLiveness,
  registerVisiblePaneLiveness,
  type VisiblePaneLivenessEntry
} from './visible-pane-output-liveness'

type Harness = {
  entry: VisiblePaneLivenessEntry
  terminal: object
  state: { ptyId: string | null; onScreen: boolean; received: number; model: number }
}

function makePane(ptyId = 'pty-1'): Harness {
  const terminal = {}
  const state = { ptyId: ptyId as string | null, onScreen: true, received: 0, model: 1 }
  const entry: VisiblePaneLivenessEntry = {
    terminal,
    getPtyId: () => state.ptyId,
    isOnScreen: () => state.onScreen,
    requestRecovery: vi.fn()
  }
  registerVisiblePaneLiveness(entry)
  return { entry, terminal, state }
}

function tick(pane: Harness, opts: { gated?: boolean; modelKnown?: boolean } = {}) {
  const ptyId = pane.state.ptyId ?? ''
  return judgeVisiblePaneLiveness({
    modelOutputSequenceByPty: opts.modelKnown === false ? {} : { [ptyId]: pane.state.model },
    hiddenGatedPtyIds: opts.gated ? [ptyId] : [],
    getReceivedChars: () => pane.state.received,
    stallTicksToRecover: 2
  })
}

afterEach(() => {
  _resetVisiblePaneLivenessForTests()
})

describe('visible pane output liveness', () => {
  it('flags a gated pane: the model advances, nothing is received', () => {
    const pane = makePane()
    expect(tick(pane, { gated: true })).toEqual([])
    pane.state.model += 5
    expect(tick(pane, { gated: true })).toEqual([])
    pane.state.model += 5
    const verdicts = tick(pane, { gated: true })
    expect(verdicts).toHaveLength(1)
    expect(verdicts[0]).toMatchObject({
      ptyId: 'pty-1',
      cause: 'output-not-received',
      hiddenGated: true
    })
  })

  it('flags a dead pipeline even though bytes keep arriving (and crediting)', () => {
    const pane = makePane()
    tick(pane)
    notifyUndeliverableWrite(pane.terminal, 'write-stalled')
    for (let i = 0; i < 2; i++) {
      pane.state.model += 5
      pane.state.received += 100
      recordTerminalParseProgress(pane.terminal)
      if (i === 0) {
        expect(tick(pane)).toEqual([])
      }
    }
    expect(tick(pane)).toEqual([expect.objectContaining({ cause: 'pipeline-dead' })])
    _resetWritePipelineHealthForTests(pane.terminal)
  })

  it('flags bytes received but never parsed', () => {
    const pane = makePane()
    tick(pane)
    pane.state.model += 5
    pane.state.received += 100
    expect(tick(pane)).toEqual([])
    pane.state.model += 5
    pane.state.received += 100
    expect(tick(pane)).toEqual([expect.objectContaining({ cause: 'output-not-parsed' })])
  })

  it('never flags a pane that keeps up with its model (negative control)', () => {
    const pane = makePane()
    tick(pane)
    for (let i = 0; i < 6; i++) {
      pane.state.model += 5
      pane.state.received += 100
      recordTerminalParseProgress(pane.terminal)
      expect(tick(pane)).toEqual([])
    }
  })

  it('does not count an idle PTY: a frozen pane with no new model output is not a stall', () => {
    const pane = makePane()
    for (let i = 0; i < 5; i++) {
      expect(tick(pane)).toEqual([])
    }
  })

  it('treats unknown model progress as unknown, never as a stall', () => {
    const pane = makePane()
    for (let i = 0; i < 5; i++) {
      pane.state.model += 5
      expect(tick(pane, { modelKnown: false })).toEqual([])
    }
  })

  it('ignores a pane that is not on screen and forgets its streak', () => {
    const pane = makePane()
    tick(pane)
    pane.state.model += 5
    tick(pane)
    pane.state.onScreen = false
    pane.state.model += 5
    expect(tick(pane)).toEqual([])
    expect(collectOnScreenPtyIds()).toEqual([])
    pane.state.onScreen = true
    pane.state.model += 5
    // Fresh observation after returning on screen: one more stall tick is not enough.
    expect(tick(pane)).toEqual([])
    pane.state.model += 5
    expect(tick(pane)).toEqual([])
  })

  it('sparse updates separated by quiet ticks never accumulate into a recovery', () => {
    const pane = makePane()
    tick(pane)
    for (let i = 0; i < 4; i++) {
      pane.state.model += 5
      expect(tick(pane)).toEqual([])
      // Quiet tick: neither side moved.
      expect(tick(pane)).toEqual([])
    }
  })

  it('parsing bytes received before the previous tick counts as progress', () => {
    const pane = makePane()
    tick(pane)
    pane.state.model += 5
    expect(tick(pane)).toEqual([])
    pane.state.model += 5
    recordTerminalParseProgress(pane.terminal)
    expect(tick(pane)).toEqual([])
    pane.state.model += 5
    expect(tick(pane)).toEqual([])
  })

  it('pane progress resets the streak', () => {
    const pane = makePane()
    tick(pane)
    pane.state.model += 5
    tick(pane)
    pane.state.model += 5
    pane.state.received += 10
    recordTerminalParseProgress(pane.terminal)
    expect(tick(pane)).toEqual([])
    pane.state.model += 5
    expect(tick(pane)).toEqual([])
  })

  it('a rebind to a new PTY starts a fresh observation', () => {
    const pane = makePane()
    tick(pane)
    pane.state.model += 5
    tick(pane)
    pane.state.ptyId = 'pty-2'
    pane.state.model += 5
    expect(tick(pane)).toEqual([])
  })

  it('collects on-screen PTY ids once per PTY', () => {
    makePane('pty-a')
    makePane('pty-a')
    const hidden = makePane('pty-b')
    hidden.state.onScreen = false
    expect(collectOnScreenPtyIds()).toEqual(['pty-a'])
  })
})
