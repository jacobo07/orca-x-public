import { describe, expect, it } from 'vitest'
import {
  createRendererLivenessWatch,
  type RendererLivenessObservation
} from './renderer-liveness-watch'

function makeWatch(startAt = 1_000) {
  let clock = startAt
  const observations: RendererLivenessObservation[] = []
  const watch = createRendererLivenessWatch({
    now: () => clock,
    onObservation: (observation) => observations.push(observation)
  })
  return {
    watch,
    observations,
    advance: (ms: number) => {
      clock += ms
    }
  }
}

describe('renderer liveness watch', () => {
  it('records a stall and the recovery that closed it, with its duration', () => {
    const { watch, observations, advance } = makeWatch()

    watch.markUnresponsive()
    advance(4_200)
    watch.markResponsive()

    expect(observations).toEqual([
      { kind: 'unresponsive', at: 1_000 },
      { kind: 'responsive', at: 5_200, unresponsiveMs: 4_200 }
    ])
    expect(watch.unresponsiveSince).toBeNull()
  })

  it('does not re-anchor the clock when Electron re-emits during one stall', () => {
    const { watch, observations, advance } = makeWatch()

    watch.markUnresponsive()
    advance(3_000)
    watch.markUnresponsive()
    advance(3_000)
    watch.markResponsive()

    // One stall, reported once, measured from its start rather than from the last notification.
    expect(observations).toHaveLength(2)
    expect(observations[1]).toEqual({ kind: 'responsive', at: 7_000, unresponsiveMs: 6_000 })
  })

  it('ignores a recovery for a stall it never observed', () => {
    const { watch, observations } = makeWatch()

    watch.markResponsive()

    expect(observations).toEqual([])
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
    const { watch, observations, advance } = makeWatch()

    watch.markUnresponsive()
    advance(1_500)
    watch.markResponsive()
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
})
