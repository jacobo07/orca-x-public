/**
 * The last painted frame of a window, held across a deliberate reload so the new document can
 * paint it immediately instead of showing the window's `backgroundColor` and then an empty shell.
 *
 * Why this exists: `webContents.reload()` destroys the document while the window stays visible, so
 * the compositor falls back to the solid `backgroundColor` (white in light mode) and the React tree
 * then mounts against an empty store and populates across the whole serial hydration chain. That is
 * one flash plus a dozen visible layout jumps for an operation the user experiences as "refresh".
 *
 * The frame is evidence of a moment, so it is single-use and age-bounded: a frame that outlives its
 * own reload would paint a lie about current state over a live app.
 */

import type { ReloadFreezeFrame } from '../../shared/reload-freeze-frame'

export type { ReloadFreezeFrame }

/** The slice of Electron's NativeImage this module needs, so the logic is testable without Electron. */
export type ReloadFreezeFrameImage = {
  isEmpty: () => boolean
  getSize: () => { width: number; height: number }
  resize: (options: { width: number; height: number }) => ReloadFreezeFrameImage
  toJPEG: (quality: number) => Buffer
}

export type ReloadFreezeFrameSource = {
  id: number
  capturePage: () => Promise<ReloadFreezeFrameImage>
  /** Logical content size. Physical capture pixels are downscaled to it, since the renderer
   *  paints the frame back in CSS pixels — on a 2x display that is 4x fewer pixels for free. */
  getContentSize?: () => { width: number; height: number } | null
}

type StoredFrame = ReloadFreezeFrame & { capturedAt: number }

/** Capture must never delay the reload the user asked for; past this it is abandoned. */
export const FREEZE_FRAME_CAPTURE_TIMEOUT_MS = 250
/** A frame older than one reload's worth of loading is not this load's frame. */
export const FREEZE_FRAME_MAX_AGE_MS = 15_000
/** A frame is a transient backdrop, not an asset: past this it is not worth the IPC. */
export const FREEZE_FRAME_MAX_BYTES = 8 * 1024 * 1024
const FREEZE_FRAME_JPEG_QUALITY = 92

const frames = new Map<number, StoredFrame>()

function pruneExpired(now: number): void {
  for (const [id, frame] of frames) {
    if (now - frame.capturedAt > FREEZE_FRAME_MAX_AGE_MS) {
      frames.delete(id)
    }
  }
}

function encode(
  image: ReloadFreezeFrameImage,
  source: ReloadFreezeFrameSource
): ReloadFreezeFrame | null {
  // An empty NativeImage encodes to a valid-looking data URL for a blank rectangle, which is worse
  // than no frame: it paints an opaque void over the app rather than falling back to today's reload.
  if (image.isEmpty()) {
    return null
  }
  const captured = image.getSize()
  if (!(captured.width > 0) || !(captured.height > 0)) {
    return null
  }

  const logical = source.getContentSize?.() ?? null
  const shouldResize =
    logical !== null &&
    logical.width > 0 &&
    logical.height > 0 &&
    (logical.width !== captured.width || logical.height !== captured.height)
  const sized = shouldResize
    ? image.resize({ width: logical.width, height: logical.height })
    : image
  const size = shouldResize ? logical : captured

  const jpeg = sized.toJPEG(FREEZE_FRAME_JPEG_QUALITY)
  if (!jpeg || jpeg.length === 0 || jpeg.length > FREEZE_FRAME_MAX_BYTES) {
    return null
  }
  return {
    dataUrl: `data:image/jpeg;base64,${jpeg.toString('base64')}`,
    width: size.width,
    height: size.height
  }
}

/**
 * Capture the window's current frame for the reload that is about to happen.
 *
 * Resolves to whether a frame was stored, and never rejects: a reload the user asked for must not
 * be cancelled, delayed past the timeout, or turned into an error by its own cosmetic backdrop.
 */
export async function captureReloadFreezeFrame(
  source: ReloadFreezeFrameSource,
  deps: { now?: () => number; timeoutMs?: number } = {}
): Promise<boolean> {
  const now = deps.now ?? Date.now
  const timeoutMs = deps.timeoutMs ?? FREEZE_FRAME_CAPTURE_TIMEOUT_MS
  pruneExpired(now())
  // A stale frame from an abandoned reload must not survive into this one's window.
  frames.delete(source.id)

  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const image = await Promise.race([
      source.capturePage(),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs)
      })
    ])
    if (!image) {
      return false
    }
    const frame = encode(image, source)
    if (!frame) {
      return false
    }
    frames.set(source.id, { ...frame, capturedAt: now() })
    return true
  } catch {
    return false
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}

/**
 * Hand the frame to the reloaded document, once.
 *
 * Single-use because the next load of the same window is a different moment, and age-bounded
 * because a reload that never finished must not leave a frame for whatever loads next.
 */
export function takeReloadFreezeFrame(
  webContentsId: number,
  deps: { now?: () => number } = {}
): ReloadFreezeFrame | null {
  const now = (deps.now ?? Date.now)()
  pruneExpired(now)
  const stored = frames.get(webContentsId)
  if (!stored) {
    return null
  }
  frames.delete(webContentsId)
  return { dataUrl: stored.dataUrl, width: stored.width, height: stored.height }
}

/** Drop a window's pending frame — used when the window goes away before its reload lands. */
export function discardReloadFreezeFrame(webContentsId: number): void {
  frames.delete(webContentsId)
}

/** Test seam: the store is module-level because it outlives the document it describes. */
export function resetReloadFreezeFramesForTest(): void {
  frames.clear()
}
