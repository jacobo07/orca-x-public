// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWorktreeCardDecorationRefresh } from './worktree-card-decoration-refresh'

function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
  document.dispatchEvent(new Event('visibilitychange'))
}

describe('worktree card decoration refresh', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    setVisibility('visible')
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('arms one clock on the first subscriber and disarms it on the last', () => {
    const refresh = createWorktreeCardDecorationRefresh()
    expect(refresh.inspect().clockRunning).toBe(false)
    const a = refresh.register('hosted-review', 'a', vi.fn())
    const b = refresh.register('linked-issue', 'b', vi.fn())
    expect(refresh.inspect().clockRunning).toBe(true)
    expect(vi.getTimerCount()).toBe(1)
    a()
    expect(refresh.inspect().clockRunning).toBe(true)
    b()
    expect(refresh.inspect()).toMatchObject({ clockRunning: false, holders: 0 })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('asks one subject once however many cards show it', () => {
    const refresh = createWorktreeCardDecorationRefresh()
    const first = vi.fn()
    const second = vi.fn()
    const releaseFirst = refresh.register('hosted-review', 'same', first)
    const releaseSecond = refresh.register('hosted-review', 'same', second)
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).not.toHaveBeenCalled()
    vi.advanceTimersByTime(60_000)
    // Why: the latest holder's closure carries the freshest arguments for that subject.
    expect(second).toHaveBeenCalledTimes(1)
    expect(first).toHaveBeenCalledTimes(1)
    releaseSecond()
    releaseSecond()
    expect(refresh.inspect().subjects['hosted-review']).toBe(1)
    releaseFirst()
    expect(refresh.inspect().subjects['hosted-review']).toBe(0)
  })

  it('keeps each family on its own cadence', () => {
    const refresh = createWorktreeCardDecorationRefresh()
    const review = vi.fn()
    const issue = vi.fn()
    refresh.register('hosted-review', 'r', review)
    refresh.register('linked-issue', 'i', issue)
    vi.advanceTimersByTime(10 * 60_000)
    expect(review).toHaveBeenCalledTimes(11)
    expect(issue).toHaveBeenCalledTimes(3)
  })

  it('runs a late subject at once while visible, and not while hidden', () => {
    const refresh = createWorktreeCardDecorationRefresh()
    refresh.register('hosted-review', 'anchor', vi.fn())
    const late = vi.fn()
    refresh.register('hosted-review', 'late', late)
    expect(late).toHaveBeenCalledTimes(1)
    setVisibility('hidden')
    const hidden = vi.fn()
    refresh.register('linked-issue', 'hidden', hidden)
    vi.advanceTimersByTime(10 * 60_000)
    expect(hidden).not.toHaveBeenCalled()
    expect(late).toHaveBeenCalledTimes(1)
    setVisibility('visible')
    expect(hidden).toHaveBeenCalledTimes(1)
    expect(late).toHaveBeenCalledTimes(2)
  })

  it('restarts the family phase when the window becomes visible', () => {
    const refresh = createWorktreeCardDecorationRefresh()
    const issue = vi.fn()
    refresh.register('linked-issue', 'i', issue)
    vi.advanceTimersByTime(4 * 60_000)
    setVisibility('hidden')
    setVisibility('visible')
    expect(issue).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(4 * 60_000)
    expect(issue).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(60_000)
    expect(issue).toHaveBeenCalledTimes(3)
  })

  it('keeps refreshing the other subjects when one throws or rejects', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const refresh = createWorktreeCardDecorationRefresh()
    refresh.register('hosted-review', 'throws', () => {
      throw new Error('gh exploded')
    })
    refresh.register('hosted-review', 'rejects', () => Promise.reject(new Error('ipc failed')))
    const healthy = vi.fn()
    refresh.register('hosted-review', 'healthy', healthy)
    vi.advanceTimersByTime(2 * 60_000)
    expect(healthy).toHaveBeenCalledTimes(3)
    expect(errors).toHaveBeenCalled()
    errors.mockRestore()
  })

  it('never calls a released subject again', () => {
    const refresh = createWorktreeCardDecorationRefresh()
    refresh.register('hosted-review', 'anchor', vi.fn())
    const oldHead = vi.fn()
    const release = refresh.register('hosted-review', 'branch\0head-1', oldHead)
    release()
    const newHead = vi.fn()
    refresh.register('hosted-review', 'branch\0head-2', newHead)
    vi.advanceTimersByTime(3 * 60_000)
    expect(oldHead).toHaveBeenCalledTimes(1)
    expect(newHead).toHaveBeenCalledTimes(4)
  })

  it('does not stack ticks while a subject is still in flight', () => {
    const refresh = createWorktreeCardDecorationRefresh()
    const pending = vi.fn(() => new Promise(() => {}))
    refresh.register('hosted-review', 'slow', pending)
    vi.advanceTimersByTime(5 * 60_000)
    // One call per tick, never a queued backlog; the store single-flights the underlying request.
    expect(pending).toHaveBeenCalledTimes(6)
    expect(vi.getTimerCount()).toBe(1)
  })
})
