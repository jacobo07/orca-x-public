import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  captureReloadFreezeFrame,
  discardReloadFreezeFrame,
  FREEZE_FRAME_MAX_AGE_MS,
  FREEZE_FRAME_MAX_BYTES,
  resetReloadFreezeFramesForTest,
  takeReloadFreezeFrame,
  type ReloadFreezeFrameImage,
  type ReloadFreezeFrameSource
} from './reload-freeze-frame'

function makeImage(
  overrides: Partial<{
    empty: boolean
    width: number
    height: number
    bytes: number
    onResize: (options: { width: number; height: number }) => void
  }> = {}
): ReloadFreezeFrameImage {
  const width = overrides.width ?? 100
  const height = overrides.height ?? 50
  const bytes = overrides.bytes ?? 64
  const image: ReloadFreezeFrameImage = {
    isEmpty: () => overrides.empty ?? false,
    getSize: () => ({ width, height }),
    resize: (options) => {
      overrides.onResize?.(options)
      return makeImage({ ...overrides, width: options.width, height: options.height })
    },
    toJPEG: () => Buffer.alloc(bytes, 1)
  }
  return image
}

function makeSource(
  overrides: Partial<ReloadFreezeFrameSource> & { image?: ReloadFreezeFrameImage } = {}
): ReloadFreezeFrameSource {
  return {
    id: overrides.id ?? 1,
    capturePage: overrides.capturePage ?? (() => Promise.resolve(overrides.image ?? makeImage())),
    ...(overrides.getContentSize ? { getContentSize: overrides.getContentSize } : {})
  }
}

describe('reload freeze frame', () => {
  beforeEach(() => {
    resetReloadFreezeFramesForTest()
  })

  it('hands the captured frame to the reloaded document exactly once', async () => {
    await expect(captureReloadFreezeFrame(makeSource({ id: 7 }))).resolves.toBe(true)

    const frame = takeReloadFreezeFrame(7)

    expect(frame?.dataUrl.startsWith('data:image/jpeg;base64,')).toBe(true)
    expect(frame).toMatchObject({ width: 100, height: 50 })
    // The next load of the same window is a different moment.
    expect(takeReloadFreezeFrame(7)).toBeNull()
  })

  it('downscales the physical capture to the window content size', async () => {
    const onResize = vi.fn()
    await captureReloadFreezeFrame(
      makeSource({
        id: 2,
        image: makeImage({ width: 2560, height: 1440, onResize }),
        getContentSize: () => ({ width: 1280, height: 720 })
      })
    )

    expect(onResize).toHaveBeenCalledWith({ width: 1280, height: 720 })
    expect(takeReloadFreezeFrame(2)).toMatchObject({ width: 1280, height: 720 })
  })

  it('does not resize when the capture already matches the content size', async () => {
    const onResize = vi.fn()
    await captureReloadFreezeFrame(
      makeSource({
        id: 3,
        image: makeImage({ width: 1280, height: 720, onResize }),
        getContentSize: () => ({ width: 1280, height: 720 })
      })
    )

    expect(onResize).not.toHaveBeenCalled()
  })

  it('refuses an empty capture rather than painting an opaque void over the app', async () => {
    await expect(
      captureReloadFreezeFrame(makeSource({ id: 4, image: makeImage({ empty: true }) }))
    ).resolves.toBe(false)

    expect(takeReloadFreezeFrame(4)).toBeNull()
  })

  it('refuses a zero-sized capture', async () => {
    await expect(
      captureReloadFreezeFrame(makeSource({ id: 5, image: makeImage({ width: 0, height: 0 }) }))
    ).resolves.toBe(false)

    expect(takeReloadFreezeFrame(5)).toBeNull()
  })

  it('refuses a frame too large to be worth the IPC', async () => {
    await expect(
      captureReloadFreezeFrame(
        makeSource({ id: 6, image: makeImage({ bytes: FREEZE_FRAME_MAX_BYTES + 1 }) })
      )
    ).resolves.toBe(false)

    expect(takeReloadFreezeFrame(6)).toBeNull()
  })

  it('abandons a capture that would delay the reload, without throwing', async () => {
    await expect(
      captureReloadFreezeFrame(makeSource({ id: 8, capturePage: () => new Promise(() => {}) }), {
        timeoutMs: 0
      })
    ).resolves.toBe(false)

    expect(takeReloadFreezeFrame(8)).toBeNull()
  })

  it('survives a capture that rejects', async () => {
    await expect(
      captureReloadFreezeFrame(
        makeSource({ id: 9, capturePage: () => Promise.reject(new Error('gpu gone')) })
      )
    ).resolves.toBe(false)

    expect(takeReloadFreezeFrame(9)).toBeNull()
  })

  it('refuses a frame that outlived its own reload', async () => {
    let now = 1_000
    await captureReloadFreezeFrame(makeSource({ id: 10 }), { now: () => now })

    now += FREEZE_FRAME_MAX_AGE_MS + 1

    expect(takeReloadFreezeFrame(10, { now: () => now })).toBeNull()
  })

  it('keeps a frame that is still within its reload window', async () => {
    let now = 1_000
    await captureReloadFreezeFrame(makeSource({ id: 11 }), { now: () => now })

    now += FREEZE_FRAME_MAX_AGE_MS - 1

    expect(takeReloadFreezeFrame(11, { now: () => now })).not.toBeNull()
  })

  it('replaces a previous frame for the same window instead of stacking', async () => {
    await captureReloadFreezeFrame(
      makeSource({ id: 12, image: makeImage({ width: 10, height: 10 }) })
    )
    await captureReloadFreezeFrame(
      makeSource({ id: 12, image: makeImage({ width: 20, height: 20 }) })
    )

    expect(takeReloadFreezeFrame(12)).toMatchObject({ width: 20, height: 20 })
    expect(takeReloadFreezeFrame(12)).toBeNull()
  })

  it('leaves no frame behind when a failed capture follows a good one', async () => {
    await captureReloadFreezeFrame(makeSource({ id: 13 }))
    await captureReloadFreezeFrame(
      makeSource({ id: 13, capturePage: () => Promise.reject(new Error('destroyed')) })
    )

    expect(takeReloadFreezeFrame(13)).toBeNull()
  })

  it('discards a pending frame when its window goes away', async () => {
    await captureReloadFreezeFrame(makeSource({ id: 14 }))

    discardReloadFreezeFrame(14)

    expect(takeReloadFreezeFrame(14)).toBeNull()
  })
})
