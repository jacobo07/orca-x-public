import { describe, expect, it } from 'vitest'
import {
  createRendererLivenessWatch,
  RENDERER_RESPONSIVE_SETTLE_MS,
  type RendererLivenessObservation
} from './renderer-liveness-watch'

function makeWatch(startAt = 1_000) {
  let clock = startAt
  const observations: RendererLivenessObservation[] = []
  const pending: { run: () => void; delayMs: number; cancelled: boolean }[] = []
  const watch = createRendererLivenessWatch({
    now: () => clock,
    onObservation: (observation) => observations.push(observation),
    schedule: (run, delayMs) => {
      const timer = { run, delayMs, cancelled: false }
      pending.push(timer)
      return {
        cancel: () => {
          timer.cancelled = true
        }
      }
    }
  })
  return {
    watch,
    observations,
    pending,
    advance: (ms: number) => {
      clock += ms
    },
    // Fires every scheduled callback that was not cancelled, as the real timer would.
    settle: () => {
      for (const timer of pending.splice(0)) {
        if (!timer.cancelled) {
          timer.run()
        }
      }
    }
  }
}

describe('renderer liveness watch', () => {
  it('records a stall and the recovery that closed it, with its duration', () => {
    const { watch, observations, advance, settle } = makeWatch()

    watch.markUnresponsive()
    advance(4_200)
    watch.markResponsive()
    settle()

    expect(observations).toEqual([
      { kind: 'unresponsive', at: 1_000 },
      { kind: 'responsive', at: 5_200, unresponsiveMs: 4_200 }
    ])
    expect(watch.unresponsiveSince).toBeNull()
  })

  it('does not re-anchor the clock when Electron re-emits during one stall', () => {
    const { watch, observations, advance, settle } = makeWatch()

    watch.markUnresponsive()
    advance(3_000)
    watch.markUnresponsive()
    advance(3_000)
    watch.markResponsive()
    settle()

    // One stall, reported once, measured from its start rather than from the last notification.
    expect(observations).toHaveLength(2)
    expect(observations[1]).toEqual({ kind: 'responsive', at: 7_000, unresponsiveMs: 6_000 })
  })

  it('ignores a recovery for a stall it never observed', () => {
    const { watch, observations, pending, settle } = makeWatch()

    watch.markResponsive()
    settle()

    expect(observations).toEqual([])
    expect(pending).toHaveLength(0)
  })

  it('reports a stall that never cleared when the window goes away', () => {
    const { watch, observations, advance } = makeWatch()

    watch.markUnresponsive()
    advance(90_000)
    watch.markGone('closed')

    // The reported freeze is only cleared by restarting Orca, so this is the shape that matters:
    // an `abandoned` record is the evidence a `responsive` would have replaced.
    expect(observations[1]).toEqual({
      kind: 'abandoned',
      at: 91_000,
      unresponsiveMs: 90_000,
      reason: 'closed'
    })
  })

  it('stays silent when a healthy window closes', () => {
    const { watch, observations } = makeWatch()

    watch.markGone('closed')

    expect(observations).toEqual([])
  })

  it('separates a recovered stall from an abandoned one across a second stall', () => {
    const { watch, observations, advance, settle } = makeWatch()

    watch.markUnresponsive()
    advance(1_500)
    watch.markResponsive()
    settle()
    advance(10_000)
    watch.markUnresponsive()
    advance(2_500)
    watch.markGone('process-gone')

    expect(observations.map((observation) => observation.kind)).toEqual([
      'unresponsive',
      'responsive',
      'unresponsive',
      'abandoned'
    ])
    expect(observations[3]).toEqual({
      kind: 'abandoned',
      at: 15_000,
      unresponsiveMs: 2_500,
      reason: 'process-gone'
    })
  })

  describe('a responsive emitted by teardown', () => {
    // Measured on Electron 43: closing or destroy()ing a window already flagged unresponsive
    // emits 'responsive' 2-3 ms into teardown and 18-22 ms before 'closed', renderer still busy.
    it('is not a recovery when the window goes away before it settles', () => {
      const { watch, observations, advance, settle } = makeWatch()

      watch.markUnresponsive()
      advance(10_000)
      watch.markResponsive()
      advance(20)
      watch.markGone('closed')
      settle()

      expect(observations).toEqual([
        { kind: 'unresponsive', at: 1_000 },
        { kind: 'abandoned', at: 11_020, unresponsiveMs: 10_020, reason: 'closed' }
      ])
    })

    it('is not a recovery when the renderer dies before it settles', () => {
      const { watch, observations, advance } = makeWatch()

      watch.markUnresponsive()
      advance(3_000)
      watch.markResponsive()
      advance(5)
      watch.markGone('process-gone')

      expect(observations.map((observation) => observation.kind)).toEqual([
        'unresponsive',
        'abandoned'
      ])
    })

    it('waits the settle window before recording, and keeps the stall open meanwhile', () => {
      const { watch, observations, pending, advance } = makeWatch()

      watch.markUnresponsive()
      advance(2_000)
      watch.markResponsive()

      expect(observations).toEqual([{ kind: 'unresponsive', at: 1_000 }])
      expect(pending).toHaveLength(1)
      expect(pending[0]?.delayMs).toBe(RENDERER_RESPONSIVE_SETTLE_MS)
      expect(watch.unresponsiveSince).toBe(1_000)
    })

    it('records a recovery that settled with the time it happened, not when it settled', () => {
      const { watch, observations, advance, settle } = makeWatch()

      watch.markUnresponsive()
      advance(2_000)
      watch.markResponsive()
      advance(RENDERER_RESPONSIVE_SETTLE_MS)
      settle()
      watch.markGone('closed')

      expect(observations).toEqual([
        { kind: 'unresponsive', at: 1_000 },
        { kind: 'responsive', at: 3_000, unresponsiveMs: 2_000 }
      ])
    })

    it('commits a held recovery when a new stall starts inside the settle window', () => {
      const { watch, observations, advance, settle } = makeWatch()

      watch.markUnresponsive()
      advance(2_000)
      watch.markResponsive()
      advance(300)
      watch.markUnresponsive()
      settle()

      expect(observations).toEqual([
        { kind: 'unresponsive', at: 1_000 },
        { kind: 'responsive', at: 3_000, unresponsiveMs: 2_000 },
        { kind: 'unresponsive', at: 3_300 }
      ])
      expect(watch.unresponsiveSince).toBe(3_300)
    })

    it('ignores a repeated responsive while one is already held', () => {
      const { watch, observations, pending, advance, settle } = makeWatch()

      watch.markUnresponsive()
      advance(1_000)
      watch.markResponsive()
      advance(1)
      watch.markResponsive()
      settle()

      expect(pending).toHaveLength(0)
      expect(observations.map((observation) => observation.kind)).toEqual([
        'unresponsive',
        'responsive'
      ])
    })
  })
})
