/**
 * A window's last painted frame, captured by main just before a deliberate reload and handed to the
 * document that replaces it so the reload reads as one step instead of a flash plus a dozen jumps.
 */
export type ReloadFreezeFrame = {
  /** JPEG data URL, already downscaled from capture pixels to CSS pixels. */
  dataUrl: string
  /** CSS-pixel size the frame was captured at, so a resized window can refuse a mismatched frame. */
  width: number
  height: number
}
