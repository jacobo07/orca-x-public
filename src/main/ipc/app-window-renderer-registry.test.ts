// Trust used to be a scalar stamped on every window construction, so opening a second window
// de-trusted the first — and because cleanup is id-guarded, closing the second never gave it back.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const liveWebContentsIds = new Set<number>()
const sendsByWebContentsId = new Map<number, ReturnType<typeof vi.fn>>()

function sendSpyFor(id: number): ReturnType<typeof vi.fn> {
  const existing = sendsByWebContentsId.get(id)
  if (existing) {
    return existing
  }
  const created = vi.fn()
  sendsByWebContentsId.set(id, created)
  return created
}

vi.mock('electron', () => ({
  webContents: {
    fromId: (id: number) =>
      liveWebContentsIds.has(id)
        ? { id, isDestroyed: () => false, send: sendSpyFor(id) }
        : null
  }
}))

import {
  broadcastToAppWindowRenderers,
  getPrimaryAppWindowRenderer,
  hasNoAppWindowRenderer,
  isAppWindowRenderer,
  registerAppWindowRenderer,
  resetAppWindowRendererRegistryForTest,
  unregisterAppWindowRenderer
} from './app-window-renderer-registry'

const WINDOW_A = 11
const WINDOW_B = 22

describe('app window renderer registry', () => {
  beforeEach(() => {
    resetAppWindowRendererRegistryForTest()
    liveWebContentsIds.clear()
    sendsByWebContentsId.clear()
    liveWebContentsIds.add(WINDOW_A)
    liveWebContentsIds.add(WINDOW_B)
  })

  it('broadcasts a global-registry change to every registered window', () => {
    registerAppWindowRenderer(WINDOW_A)
    registerAppWindowRenderer(WINDOW_B)

    broadcastToAppWindowRenderers('repos:changed')

    expect(sendSpyFor(WINDOW_A)).toHaveBeenCalledWith('repos:changed')
    expect(sendSpyFor(WINDOW_B)).toHaveBeenCalledWith('repos:changed')
  })

  it('skips the origin so the window that already got the event is not sent it twice', () => {
    registerAppWindowRenderer(WINDOW_A)
    registerAppWindowRenderer(WINDOW_B)

    broadcastToAppWindowRenderers('worktrees:changed', [{ repoId: 'repo-1' }], WINDOW_A)

    expect(sendSpyFor(WINDOW_A)).not.toHaveBeenCalled()
    expect(sendSpyFor(WINDOW_B)).toHaveBeenCalledWith('worktrees:changed', { repoId: 'repo-1' })
  })

  it('skips a window that has gone without dropping the rest of the broadcast', () => {
    registerAppWindowRenderer(WINDOW_A)
    registerAppWindowRenderer(WINDOW_B)
    liveWebContentsIds.delete(WINDOW_A)

    broadcastToAppWindowRenderers('repos:changed')

    expect(sendSpyFor(WINDOW_B)).toHaveBeenCalledWith('repos:changed')
  })

  it('reports no app window before the first registration, so callers keep their fallback', () => {
    expect(hasNoAppWindowRenderer()).toBe(true)

    registerAppWindowRenderer(WINDOW_A)

    expect(hasNoAppWindowRenderer()).toBe(false)
  })

  it('keeps the first window trusted after a second one registers', () => {
    registerAppWindowRenderer(WINDOW_A)
    registerAppWindowRenderer(WINDOW_B)

    expect(isAppWindowRenderer(WINDOW_A)).toBe(true)
    expect(isAppWindowRenderer(WINDOW_B)).toBe(true)
  })

  it('keeps the survivor trusted when the other window closes', () => {
    registerAppWindowRenderer(WINDOW_A)
    registerAppWindowRenderer(WINDOW_B)

    unregisterAppWindowRenderer(WINDOW_B)

    expect(isAppWindowRenderer(WINDOW_A)).toBe(true)
    expect(isAppWindowRenderer(WINDOW_B)).toBe(false)
  })

  it('does not trust a renderer that never registered', () => {
    registerAppWindowRenderer(WINDOW_A)

    expect(isAppWindowRenderer(99)).toBe(false)
  })

  it('addresses the most recently registered window for a single-target send', () => {
    registerAppWindowRenderer(WINDOW_A)
    registerAppWindowRenderer(WINDOW_B)

    expect(getPrimaryAppWindowRenderer()?.id).toBe(WINDOW_B)
  })

  it('falls back to a live window rather than to nothing when the newest is gone', () => {
    registerAppWindowRenderer(WINDOW_A)
    registerAppWindowRenderer(WINDOW_B)
    liveWebContentsIds.delete(WINDOW_B)

    expect(getPrimaryAppWindowRenderer()?.id).toBe(WINDOW_A)
  })

  it('skips the excluded origin window so a broadcast does not echo back', () => {
    registerAppWindowRenderer(WINDOW_A)
    registerAppWindowRenderer(WINDOW_B)

    expect(getPrimaryAppWindowRenderer(WINDOW_B)?.id).toBe(WINDOW_A)
  })

  it('re-registering an existing window makes it primary without duplicating it', () => {
    registerAppWindowRenderer(WINDOW_A)
    registerAppWindowRenderer(WINDOW_B)
    registerAppWindowRenderer(WINDOW_A)

    expect(getPrimaryAppWindowRenderer()?.id).toBe(WINDOW_A)

    // One unregister must fully remove it; a duplicate entry would leave it trusted after close.
    unregisterAppWindowRenderer(WINDOW_A)

    expect(isAppWindowRenderer(WINDOW_A)).toBe(false)
  })
})
