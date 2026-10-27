import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PaneSessionResumeResult } from './pane-session-resume-intent'
import {
  hasPaneSessionResumeHandler,
  isPaneSessionResumeInFlight,
  registerPaneSessionResumeHandler,
  requestPaneSessionResume,
  subscribePaneSessionResumeDispatch
} from './pane-session-resume-dispatch'

const cleanups: (() => void)[] = []
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
})

function deferred(): {
  promise: Promise<PaneSessionResumeResult>
  resolve: (r: PaneSessionResumeResult) => void
} {
  let resolve!: (r: PaneSessionResumeResult) => void
  const promise = new Promise<PaneSessionResumeResult>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

function register(paneKey: string, handler: () => Promise<PaneSessionResumeResult>): void {
  cleanups.push(registerPaneSessionResumeHandler(paneKey, handler))
}

describe('pane session resume dispatch', () => {
  it('answers hidden for a pane nobody mounted, and starts nothing', async () => {
    expect(await requestPaneSessionResume('tab-9:leaf')).toEqual({
      outcome: 'unavailable',
      capability: { kind: 'hidden' }
    })
  })

  it('joins a second click to the attempt already running for that pane', async () => {
    const gate = deferred()
    const handler = vi.fn(() => gate.promise)
    register('tab-1:a', handler)

    const first = requestPaneSessionResume('tab-1:a')
    const second = requestPaneSessionResume('tab-1:a')
    expect(second).toBe(first)
    expect(handler).toHaveBeenCalledTimes(1)
    expect(isPaneSessionResumeInFlight('tab-1:a')).toBe(true)

    gate.resolve({ outcome: 'started' })
    expect(await first).toEqual({ outcome: 'started' })
    expect(isPaneSessionResumeInFlight('tab-1:a')).toBe(false)

    await requestPaneSessionResume('tab-1:a')
    expect(handler).toHaveBeenCalledTimes(2)
  })

  it('routes by pane key only: resuming one pane never runs another pane’s handler', async () => {
    const a = vi.fn(async (): Promise<PaneSessionResumeResult> => ({ outcome: 'started' }))
    const b = vi.fn(async (): Promise<PaneSessionResumeResult> => ({ outcome: 'started' }))
    register('tab-1:a', a)
    register('tab-2:b', b)
    await requestPaneSessionResume('tab-1:a')
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).not.toHaveBeenCalled()
  })

  it('lets a remounted pane keep its handler when the old mount unregisters late', () => {
    const stale = registerPaneSessionResumeHandler('tab-1:a', vi.fn())
    register('tab-1:a', vi.fn())
    stale()
    expect(hasPaneSessionResumeHandler('tab-1:a')).toBe(true)
  })

  it('turns a throwing handler into a failed attempt and frees the pane for a retry', async () => {
    register('tab-1:a', () => Promise.reject(new Error('spawn blew up')))
    expect(await requestPaneSessionResume('tab-1:a')).toEqual({ outcome: 'spawn-failed' })
    expect(isPaneSessionResumeInFlight('tab-1:a')).toBe(false)
  })

  it('tells subscribers when an attempt starts and settles', async () => {
    const listener = vi.fn()
    cleanups.push(subscribePaneSessionResumeDispatch(listener))
    register('tab-1:a', async () => ({ outcome: 'started' }))
    const before = listener.mock.calls.length
    await requestPaneSessionResume('tab-1:a')
    expect(listener.mock.calls.length - before).toBe(2)
  })
})
