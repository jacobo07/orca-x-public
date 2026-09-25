// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  dismissReloadFreezeFrame,
  RELOAD_FREEZE_FRAME_MAX_VISIBLE_MS,
  RELOAD_FREEZE_FRAME_OVERLAY_ID,
  reportAppReadyForFreezeFrame,
  resetReloadFreezeFrameOverlayForTest,
  showReloadFreezeFrameIfPresent
} from './reload-freeze-frame-overlay'

const FRAME = { dataUrl: 'data:image/jpeg;base64,AAAA', width: 800, height: 600 }

function overlayElement(): HTMLElement | null {
  return document.getElementById(RELOAD_FREEZE_FRAME_OVERLAY_ID)
}

function setTakeReloadFreezeFrame(take: unknown): void {
  ;(window as unknown as { api?: unknown }).api = { app: { takeReloadFreezeFrame: take } }
}

/** happy-dom ships no HTMLImageElement.decode; Chromium has had it since 64, so the stub is the
 *  faithful double and its absence would make every overlay case silently take the failure path. */
function installImageDecode(): void {
  Object.defineProperty(HTMLImageElement.prototype, 'decode', {
    configurable: true,
    writable: true,
    value: () => Promise.resolve()
  })
}

describe('reload freeze frame overlay', () => {
  beforeEach(() => {
    installImageDecode()
    // rAF is the paint fence before uncovering; run it synchronously so the tests are deterministic.
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0)
      return 0
    })
    setTakeReloadFreezeFrame(() => Promise.resolve(FRAME))
  })

  afterEach(() => {
    resetReloadFreezeFrameOverlayForTest()
    vi.unstubAllGlobals()
    vi.useRealTimers()
    delete (window as unknown as { api?: unknown }).api
  })

  it('paints the captured frame over the shell that is still hydrating', async () => {
    await expect(showReloadFreezeFrameIfPresent()).resolves.toBe(true)

    const element = overlayElement()
    expect(element).not.toBeNull()
    expect(element?.querySelector('img')?.getAttribute('src')).toBe(FRAME.dataUrl)
    expect(element?.style.position).toBe('fixed')
    // While shown it must swallow clicks aimed at an app shell that is not ready.
    expect(element?.style.pointerEvents).toBe('auto')
  })

  it('shows nothing on a cold start, when main holds no frame', async () => {
    setTakeReloadFreezeFrame(() => Promise.resolve(null))

    await expect(showReloadFreezeFrameIfPresent()).resolves.toBe(false)

    expect(overlayElement()).toBeNull()
  })

  it('shows nothing on a runtime without the capability', async () => {
    ;(window as unknown as { api?: unknown }).api = { app: {} }

    await expect(showReloadFreezeFrameIfPresent()).resolves.toBe(false)

    expect(overlayElement()).toBeNull()
  })

  it('shows nothing when the request to main fails', async () => {
    setTakeReloadFreezeFrame(() => Promise.reject(new Error('no channel')))

    await expect(showReloadFreezeFrameIfPresent()).resolves.toBe(false)

    expect(overlayElement()).toBeNull()
  })

  it('shows nothing when the frame cannot be decoded', async () => {
    Object.defineProperty(HTMLImageElement.prototype, 'decode', {
      configurable: true,
      writable: true,
      value: () => Promise.reject(new Error('corrupt'))
    })

    await expect(showReloadFreezeFrameIfPresent()).resolves.toBe(false)

    expect(overlayElement()).toBeNull()
  })

  it('holds the frame for a paint, then hands the window back once the app is hydrated', async () => {
    // Fake timers drive requestAnimationFrame here, so the paint fence is observable.
    vi.useFakeTimers()
    await showReloadFreezeFrameIfPresent()
    expect(overlayElement()).not.toBeNull()

    reportAppReadyForFreezeFrame()

    // Still covering: the store was mutated synchronously and React has not painted the hydrated
    // shell yet, so uncovering now would reveal the empty frame this exists to hide.
    expect(overlayElement()?.style.opacity).toBe('1')

    vi.runAllTimers()
    expect(overlayElement()).toBeNull()
  })

  it('never shows a frame that finished decoding after the app was already up', async () => {
    let resolveFrame: (frame: typeof FRAME) => void = () => {}
    setTakeReloadFreezeFrame(
      () =>
        new Promise((resolve) => {
          resolveFrame = resolve
        })
    )
    const pending = showReloadFreezeFrameIfPresent()

    reportAppReadyForFreezeFrame()
    resolveFrame(FRAME)

    await expect(pending).resolves.toBe(false)
    expect(overlayElement()).toBeNull()
  })

  it('gives up on a resize, rather than stretching a frame of the old size', async () => {
    vi.useFakeTimers()
    await showReloadFreezeFrameIfPresent()

    window.dispatchEvent(new Event('resize'))

    expect(overlayElement()?.style.opacity).toBe('0')
    vi.runAllTimers()
    expect(overlayElement()).toBeNull()
  })

  it('uncovers the window on its own if hydration never reports back', async () => {
    vi.useFakeTimers()
    await showReloadFreezeFrameIfPresent()

    vi.advanceTimersByTime(RELOAD_FREEZE_FRAME_MAX_VISIBLE_MS)

    expect(overlayElement()?.style.opacity).toBe('0')
    vi.runAllTimers()
    expect(overlayElement()).toBeNull()
  })

  it('is safe to dismiss when nothing is showing', () => {
    expect(() => dismissReloadFreezeFrame()).not.toThrow()
  })
})
