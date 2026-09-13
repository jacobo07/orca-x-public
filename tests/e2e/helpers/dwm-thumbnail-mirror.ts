/**
 * Sampling the representation Windows actually shows for a window.
 *
 * Everything upstream of this -- a demand arriving, a bitmap supplied, an HRESULT of zero -- is the
 * supply side, and a preview can be frozen with every one of those looking healthy. This reads the
 * other end: DWM's own thumbnail of the window, which is what the taskbar flyout composites.
 *
 * Why not hover the real taskbar button: that measures the same surface and needs exclusive control
 * of the mouse. On a machine somebody is using, a synthetic pointer fights them, and the run is
 * wrong about the product the moment they move it back.
 */
import { execFileSync } from 'node:child_process'
import path from 'node:path'

export type DwmThumbnailFrame = {
  index: number
  /** Content hash of the composited thumbnail. Equal hashes across frames is a frozen preview. */
  hash: number
  /** Mirror background that DWM never drew over. Non-zero means the thumbnail did not fill its box. */
  unpaintedPct: number
  /**
   * How much of the thumbnail is essentially black.
   *
   * Separate from `unpaintedPct` because they catch opposite halves of "blank": that one sees a box
   * DWM never drew into, and cannot see a box DWM filled with black. The reported defect is the
   * second kind — a preview that is one dark rectangle — so a check built only on the first passes
   * the exact failure it exists to catch.
   */
  nearBlackPct: number
  /**
   * Quantised colours present in the sampled thumbnail.
   *
   * The theme-proof measure of "is this a picture of anything". A real window preview carries text,
   * chrome and edges worth thousands of quantised colours whether it is light or dark; an empty
   * surface carries one, at any brightness. Unlike a darkness threshold, this cannot be satisfied by
   * a legitimately dark window nor fooled by one.
   */
  distinctColours: number
  iconic: boolean
  /**
   * What DWM holds as the SOURCE of this thumbnail, sampled with the frame.
   *
   * The one-call discriminator between the two things a blank preview can be, which have different
   * causes and different fixes: the window's own rect means DWM composited the window and that
   * surface was blank, and 250x148 means DWM handed back the iconic bitmap the app supplied, so the
   * blank is ours. Sampled per frame rather than once at registration, because before any bitmap has
   * been supplied a window that will be served from one still reports its real rect — an early
   * reading describes a moment the verdict is not about.
   */
  sourceWidth: number
  sourceHeight: number
}

export type DwmThumbnailSample = {
  registerHresult: number
  sourceWidth?: number
  sourceHeight?: number
  /** The same reading at the end of the window, for the reason `iconicAtEnd` exists. */
  sourceWidthAtEnd?: number
  sourceHeightAtEnd?: number
  iconicAtStart?: boolean
  iconicAtEnd?: boolean
  frames: DwmThumbnailFrame[]
}

/**
 * The window handle as a number.
 *
 * Electron hands back the raw pointer bytes, so this is width-dependent and must not assume 64-bit
 * silently: a 32-bit buffer read as 64 would produce a handle that names nothing, and DWM would
 * refuse it with an HRESULT that looks like an unsupported platform rather than a bad argument.
 */
export function nativeWindowHandleToNumber(handle: Buffer): number {
  if (handle.length >= 8) {
    return Number(handle.readBigUInt64LE(0))
  }
  return handle.readUInt32LE(0)
}

/**
 * Returns null when the mirror could not run at all -- no PowerShell, wrong platform. That is a
 * setup condition, and a caller must not read it as a verdict about the thumbnail.
 */
export function sampleDwmThumbnail(options: {
  hwnd: number
  frames?: number
  intervalMs?: number
  outDir?: string
}): DwmThumbnailSample | null {
  if (process.platform !== 'win32') {
    return null
  }
  const script = path.join(__dirname, 'dwm-thumbnail-mirror.ps1')
  const args = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    script,
    '-Hwnd',
    String(options.hwnd),
    '-Frames',
    String(options.frames ?? 6),
    '-IntervalMs',
    String(options.intervalMs ?? 3000)
  ]
  if (options.outDir) {
    args.push('-OutDir', options.outDir)
  }
  try {
    const stdout = execFileSync('powershell', args, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10 * 60_000
    })
    const line = stdout
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter((value) => value.startsWith('{'))
      .pop()
    return line ? (JSON.parse(line) as DwmThumbnailSample) : null
  } catch {
    return null
  }
}

/** How many of the sampled frames were materially different from the one before. */
export function countDistinctFrames(frames: readonly DwmThumbnailFrame[]): number {
  return new Set(frames.map((frame) => frame.hash)).size
}
