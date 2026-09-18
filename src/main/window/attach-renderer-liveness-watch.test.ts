import { describe, expect, it } from 'vitest'
import {
  recordRendererLiveness,
  type RendererLivenessSubscriptions
} from './attach-renderer-liveness-watch'

type Recorded = { name: string; data: Record<string, string | number | boolean | null> }

function wire(startAt = 5_000) {
  const listeners: Record<keyof RendererLivenessSubscriptions, (() => void)[]> = {
    onUnresponsive: [],
    onResponsive: [],
    onRendererProcessGone: [],
    onClosed: []
  }
  const recorded: Recorded[] = []
  const timers: { run: () => void; cancelled: boolean }[] = []
  let clock = startAt

  recordRendererLiveness({
    windowId: 7,
    webContentsId: 42,
    now: () => clock,
    record: (name, data) => recorded.push({ name, data }),
    schedule: (run) => {
      const timer = { run, cancelled: false }
      timers.push(timer)
      return {
        cancel: () => {
          timer.cancelled = true
        }
      }
    },
    subscriptions: {
      onUnresponsive: (listener) => listeners.onUnresponsive.push(listener),
      onResponsive: (listener) => listeners.onResponsive.push(listener),
      onRendererProcessGone: (listener) => listeners.onRendererProcessGone.push(listener),
      onClosed: (listener) => listeners.onClosed.push(listener)
    }
  })

  const fire = (event: keyof RendererLivenessSubscriptions): void => {
    for (const listener of listeners[event]) {
      listener()
    }
  }
  return {
    recorded,
    fire,
    listeners,
    advance: (ms: number) => {
      clock += ms
    },
    settle: () => {
      for (const timer of timers.splice(0)) {
        if (!timer.cancelled) {
          timer.run()
        }
      }
    }
  }
}

describe('renderer liveness recording', () => {
  it('subscribes to every event it claims to observe', () => {
    const { listeners } = wire()

    // A recorder wired to no event is indistinguishable from a healthy app, so pin the wiring
    // itself: this is the half that has actually gone wrong before in guards like this.
    expect(listeners.onUnresponsive).toHaveLength(1)
    expect(listeners.onResponsive).toHaveLength(1)
    expect(listeners.onRendererProcessGone).toHaveLength(1)
    expect(listeners.onClosed).toHaveLength(1)
  })

  it('records a stall and its recovery, attributed to the window and renderer', () => {
    const { recorded, fire, advance, settle } = wire()

    fire('onUnresponsive')
    advance(2_400)
    fire('onResponsive')
    settle()

    expect(recorded).toEqual([
      { name: 'renderer_unresponsive', data: { windowId: 7, webContentsId: 42 } },
      {
        name: 'renderer_responsive',
        data: { windowId: 7, webContentsId: 42, unresponsiveMs: 2_400 }
      }
    ])
  })

  it('names a stall that never cleared differently from one that did', () => {
    const { recorded, fire, advance } = wire()

    fire('onUnresponsive')
    advance(600_000)
    fire('onClosed')

    expect(recorded[1]).toEqual({
      name: 'renderer_unresponsive_abandoned',
      data: { windowId: 7, webContentsId: 42, unresponsiveMs: 600_000, reason: 'closed' }
    })
    // The two names must not collide, or a search cannot tell a survivable stall from this one.
    expect(recorded[1]?.name).not.toBe('renderer_responsive')
  })

  it('records a frozen window torn down by quit as abandoned, not recovered', () => {
    const { recorded, fire, advance, settle } = wire()

    // Orca's frozen-quit path: close is vetoed, the renderer never acks, destroy() follows, and
    // Electron emits 'responsive' ~20 ms before 'closed' while the renderer is still busy.
    fire('onUnresponsive')
    advance(10_000)
    fire('onResponsive')
    advance(20)
    fire('onClosed')
    settle()

    expect(recorded.map((entry) => entry.name)).toEqual([
      'renderer_unresponsive',
      'renderer_unresponsive_abandoned'
    ])
    expect(recorded[1]?.data).toEqual({
      windowId: 7,
      webContentsId: 42,
      unresponsiveMs: 10_020,
      reason: 'closed'
    })
  })

  it('attributes an abandoned stall to a dead renderer when that is what ended it', () => {
    const { recorded, fire, advance } = wire()

    fire('onUnresponsive')
    advance(1_000)
    fire('onRendererProcessGone')

    expect(recorded[1]?.data.reason).toBe('process-gone')
  })

  it('records nothing for a window that closes while healthy', () => {
    const { recorded, fire } = wire()

    fire('onClosed')

    expect(recorded).toEqual([])
  })
})
