/**
 * What size to rasterize each of the two bitmaps the shell asks a window for.
 *
 * They are different pictures with different rules. The taskbar thumbnail's size arrives packed in
 * the message itself; the live preview's does not arrive at all and has to be derived from the
 * window, at the exact moment the window is least able to report it.
 */

/** Last resort for a live preview whose window will not report usable geometry. DWM rescales. */
const FALLBACK_LIVE_PREVIEW_WIDTH = 1280
const FALLBACK_LIVE_PREVIEW_HEIGHT = 800

export type TaskbarPreviewSizedWindow = {
  getContentSize(): number[]
  getBounds?(): { width: number; height: number }
}

/**
 * The shell packs the largest acceptable thumbnail size into lParam: width in the high word, height
 * in the low one. Measured against a real demand (0x00fa0094 for a landscape window => 250x148)
 * rather than taken from prose, because the documentation names the fields and not the order.
 */
export function decodeIconicThumbnailSize(
  lParam: Buffer
): { width: number; height: number } | null {
  if (lParam.length < 4) {
    return null
  }
  const packed = lParam.readUInt32LE(0)
  const width = (packed >>> 16) & 0xff_ff
  const height = packed & 0xff_ff
  return width > 0 && height > 0 ? { width, height } : null
}

/**
 * The size to rasterize a live-preview bitmap at.
 *
 * A minimized window is exactly when this is asked and exactly when the content size can come back
 * unusable — measured against the real shell, where a demand arriving after minimize was dropped
 * for having no size at all, which is the one demand the whole feature exists to answer. So the
 * window's restored bounds stand in, and a fixed size stands in after that: DWM scales whatever it
 * is given, and a preview at an imperfect aspect ratio is worth incomparably more than none.
 *
 * The WINDOW rect, not the content rect, and the order matters. DWM composites the live preview at
 * the window's own rectangle, and a bitmap smaller than that rectangle is drawn at its natural size
 * inside it rather than filling the space. Measured on a real window: rect 1544x920, client
 * 1529x912 — supplying the content size put the picture 14px narrow and 7px short, which reads as a
 * broken preview rather than a sizing bug. Content size stays as the fallback because it is the
 * better wrong answer: a correctly-shaped preview, just inset.
 */
export function resolveLivePreviewSize(window: TaskbarPreviewSizedWindow): {
  width: number
  height: number
} {
  const usable = (width: unknown, height: unknown): { width: number; height: number } | null =>
    typeof width === 'number' && typeof height === 'number' && width > 0 && height > 0
      ? { width: Math.round(width), height: Math.round(height) }
      : null
  try {
    const bounds = window.getBounds?.()
    const fromBounds = usable(bounds?.width, bounds?.height)
    if (fromBounds) {
      return fromBounds
    }
    const [contentWidth, contentHeight] = window.getContentSize()
    const fromContent = usable(contentWidth, contentHeight)
    if (fromContent) {
      return fromContent
    }
  } catch {
    // Geometry reads can throw on a window that is being torn down; the fallback covers it.
  }
  return { width: FALLBACK_LIVE_PREVIEW_WIDTH, height: FALLBACK_LIVE_PREVIEW_HEIGHT }
}
