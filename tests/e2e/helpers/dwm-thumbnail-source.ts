/**
 * Which surface Windows is serving as a window's taskbar thumbnail.
 *
 * The taskbar preview has two postures and they are opposite trades. While the window is visible,
 * DWM composites its own surface: live, full resolution, and free. While it is minimized, DWM has no
 * surface left to composite, so the app supplies a bitmap instead — capped at the size the shell
 * asked for, and only as current as the last supply. Engaging the takeover in the wrong state is
 * therefore not a small regression: it replaces a live full-resolution composition with a 250x148
 * still, for every shell surface that reads the thumbnail.
 *
 * Nothing on the supply side can report which posture is in force — a supply returns HRESULT zero in
 * both — so this asks the only party that knows.
 */
import { execFileSync } from 'node:child_process'
import path from 'node:path'

export type DwmThumbnailSourceReading = {
  hresult: number
  sourceWidth: number
  sourceHeight: number
  rectWidth: number
  rectHeight: number
  iconic: boolean
}

export type DwmThumbnailPosture =
  /** DWM composites the window itself. The platform's own answer, and the one to prefer. */
  | 'window-surface'
  /** DWM is serving a bitmap the app supplied. Correct only while the window is minimized. */
  | 'supplied-bitmap'
  /** Neither shape: a query that failed, or a source that matches no known posture. */
  | 'indeterminate'

/**
 * The non-client frame is why this is a tolerance rather than an equality: a window whose rect is
 * 1938x1149 composites from a 1922x1141 surface. Sized against the distance between the two answers,
 * not against noise in general — the other candidate is 250x148, which no frame border comes near.
 */
const FRAME_TOLERANCE_PX = 64

/** The largest iconic thumbnail the shell asks for is 250x148; this leaves room and no ambiguity. */
const MAX_ICONIC_EDGE_PX = 320

export function classifyThumbnailPosture(reading: DwmThumbnailSourceReading): DwmThumbnailPosture {
  if (reading.hresult !== 0 || reading.sourceWidth <= 0 || reading.sourceHeight <= 0) {
    return 'indeterminate'
  }
  const matchesWindow =
    Math.abs(reading.sourceWidth - reading.rectWidth) <= FRAME_TOLERANCE_PX &&
    Math.abs(reading.sourceHeight - reading.rectHeight) <= FRAME_TOLERANCE_PX
  if (matchesWindow) {
    return 'window-surface'
  }
  if (reading.sourceWidth <= MAX_ICONIC_EDGE_PX && reading.sourceHeight <= MAX_ICONIC_EDGE_PX) {
    return 'supplied-bitmap'
  }
  return 'indeterminate'
}

/**
 * Returns null when the reading could not be taken at all — wrong platform, no PowerShell, a handle
 * that names no window. That is a setup condition and a caller must not read it as a posture.
 */
export function readDwmThumbnailSource(hwnd: number): DwmThumbnailSourceReading | null {
  if (process.platform !== 'win32') {
    return null
  }
  const script = path.join(__dirname, 'dwm-thumbnail-source.ps1')
  try {
    const stdout = execFileSync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Hwnd', String(hwnd)],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 }
    )
    // findLast, not find: PowerShell can emit its own notices before the payload, and this script
    // prints its single JSON object last.
    const line = stdout
      .split(/\r?\n/)
      .map((value) => value.trim())
      .findLast((value) => value.startsWith('{'))
    if (!line) {
      return null
    }
    const parsed = JSON.parse(line) as { status?: string } & Partial<DwmThumbnailSourceReading>
    if (parsed.status !== 'measured' || typeof parsed.sourceWidth !== 'number') {
      return null
    }
    return parsed as DwmThumbnailSourceReading
  } catch {
    return null
  }
}
