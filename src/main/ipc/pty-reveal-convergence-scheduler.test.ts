import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RevealConvergenceVerdict } from '../runtime/terminal-reveal-convergence'
import { createRevealConvergenceScheduler } from './pty-reveal-convergence-scheduler'

const DIVERGED: RevealConvergenceVerdict = {
  verdict: 'diverged',
  rows: 3,
  divergentRows: [2],
  mirrorDigest: 'm1',
  rendererDigest: 'r1'
}

function setup(verdicts: (RevealConvergenceVerdict | Error)[]) {
  const probe = vi.fn(async () => {
    const next = verdicts.shift() ?? { verdict: 'converged' as const, rows: 0 }
    if (next instanceof Error) {
      throw next
    }
    return next
  })
  const record = vi.fn()
  const scheduler = createRevealConvergenceScheduler({
    probe,
    record,
    redact: (id) => `redacted:${id}`,
    settleMs: 100
  })
  return { probe, record, scheduler }
}

async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(100)
}

describe('reveal convergence scheduler', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('judges a reveal once, after it settles, and reports a divergence content-free', async () => {
    const { probe, record, scheduler } = setup([DIVERGED])
    scheduler.onVisibility('pty-1', true, false)
    expect(probe).not.toHaveBeenCalled()
    await settle()
    expect(probe).toHaveBeenCalledTimes(1)
    expect(record).toHaveBeenCalledWith('reveal-convergence-anomaly', {
      id: 'redacted:pty-1',
      rows: 3,
      divergentRows: 1,
      firstDivergentRow: 2,
      mirror: 'm1',
      renderer: 'r1'
    })
  })

  it('never polls a pane that stays visible', async () => {
    const { probe, scheduler } = setup([])
    scheduler.onVisibility('pty-1', true, false)
    await settle()
    scheduler.onVisibility('pty-1', true, true)
    scheduler.onVisibility('pty-1', true, true)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('does not judge a pane hidden again before the reveal settled', async () => {
    const { probe, scheduler } = setup([])
    scheduler.onVisibility('pty-1', true, false)
    scheduler.onVisibility('pty-1', false, true)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(probe).not.toHaveBeenCalled()
  })

  it('reports the same divergence once across reveals, and a new one again', async () => {
    const { record, scheduler } = setup([DIVERGED, DIVERGED, { ...DIVERGED, mirrorDigest: 'm2' }])
    for (let reveal = 0; reveal < 3; reveal++) {
      scheduler.onVisibility('pty-1', true, false)
      await settle()
      scheduler.onVisibility('pty-1', false, true)
    }
    const anomalies = record.mock.calls.filter(([kind]) => kind === 'reveal-convergence-anomaly')
    expect(anomalies.map(([, detail]) => detail.mirror)).toEqual(['m1', 'm2'])
  })

  it('stays silent on a converged pane (control)', async () => {
    const { record, scheduler } = setup([{ verdict: 'converged', rows: 5 }])
    scheduler.onVisibility('pty-1', true, false)
    await settle()
    expect(record).not.toHaveBeenCalled()
  })

  it('records an unjudged reveal as unjudged, never as converged or diverged', async () => {
    const { record, scheduler } = setup([
      { verdict: 'unknown', reason: 'renderer-unavailable' },
      new Error('renderer gone')
    ])
    scheduler.onVisibility('pty-1', true, false)
    await settle()
    scheduler.onVisibility('pty-2', true, false)
    await settle()
    expect(record.mock.calls).toEqual([
      ['reveal-convergence-unjudged', { id: 'redacted:pty-1', reason: 'renderer-unavailable' }],
      ['reveal-convergence-unjudged', { id: 'redacted:pty-2', reason: 'probe-failed' }]
    ])
  })
})
