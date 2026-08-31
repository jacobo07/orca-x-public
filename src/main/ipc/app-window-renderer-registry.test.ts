// Trust used to be a scalar stamped on every window construction, so opening a second window
// de-trusted the first — and because cleanup is id-guarded, closing the second never gave it back.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const liveWebContentsIds = new Set<number>()

vi.mock('electron', () => ({
  webContents: {
    fromId: (id: number) => (liveWebContentsIds.has(id) ? { id, isDestroyed: () => false } : null)
  }
}))

import {
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
    liveWebContentsIds.add(WINDOW_A)
    liveWebContentsIds.add(WINDOW_B)
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
