/**
 * What the user's monitor shows, as opposed to what the compositor would render if asked.
 *
 * `screenshotTerminalSurface` goes through CDP, and a CDP capture makes the renderer produce a frame
 * for it. A window that Chromium has stopped presenting — because it believes the window is hidden —
 * therefore photographs as healthy while the screen shows a frozen surface. This witness reads the
 * desktop itself (GDI `CopyFromScreen`), so it can return the stale answer that the CDP one cannot.
 *
 * A screen pixel is only evidence about window A if A is the window at that point. On a live
 * desktop another application can hold the top of the z-order at any moment, so every reading also
 * reports the root window under the sampled rectangle (`WindowFromPoint` → `GetAncestor(GA_ROOT)`),
 * and a caller must treat "A is not on top" as INCONCLUSIVE, never as stale or live.
 *
 * Windows only. Callers skip elsewhere.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/** Rows below this fraction are excluded so the blinking cursor row cannot make a frozen surface differ. */
export const SAMPLED_SURFACE_FRACTION = 0.55

export type ScreenRect = { x: number; y: number; width: number; height: number }

export type PhysicalScreenReading = {
  /** True only when the root window under the rectangle's centre is the expected window. */
  expectedWindowOnTop: boolean
  /** Root HWND found at the centre, for the log. */
  topWindowHandle: string
  /** One PNG per frame, in capture order. */
  frames: Buffer[]
}

const CAPTURE_SCRIPT = `
param([int]$X,[int]$Y,[int]$W,[int]$H,[int]$Frames,[int]$DelayMs,[string]$Prefix)
Add-Type -AssemblyName System.Drawing
Add-Type -Namespace OrcaE2e -Name User32 -ReferencedAssemblies System.Drawing -MemberDefinition @'
[DllImport("user32.dll")] public static extern System.IntPtr WindowFromPoint(System.Drawing.Point p);
[DllImport("user32.dll")] public static extern System.IntPtr GetAncestor(System.IntPtr h, uint flags);
'@
$centre = New-Object System.Drawing.Point ([int]($X + $W / 2)), ([int]($Y + $H / 2))
$top = [OrcaE2e.User32]::GetAncestor([OrcaE2e.User32]::WindowFromPoint($centre), 2)
for ($i = 0; $i -lt $Frames; $i++) {
  if ($i -gt 0) { Start-Sleep -Milliseconds $DelayMs }
  $bitmap = New-Object System.Drawing.Bitmap $W, $H
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.CopyFromScreen($X, $Y, 0, 0, $bitmap.Size)
  $bitmap.Save("$Prefix-$i.png", [System.Drawing.Imaging.ImageFormat]::Png)
  $graphics.Dispose(); $bitmap.Dispose()
}
"TOP=$($top.ToInt64())"
`

/** Captures `frames` screen readings `delayMs` apart, in one process so the spawn cost is paid once. */
export function readPhysicalScreen(args: {
  rect: ScreenRect
  expectedWindowHandle: string
  frames: number
  delayMs: number
  workDir: string
  label: string
}): PhysicalScreenReading {
  const scriptPath = path.join(args.workDir, 'physical-screen-capture.ps1')
  writeFileSync(scriptPath, CAPTURE_SCRIPT, 'utf8')
  const prefix = path.join(args.workDir, `screen-${args.label}`)
  const output = execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      scriptPath,
      '-X',
      String(args.rect.x),
      '-Y',
      String(args.rect.y),
      '-W',
      String(args.rect.width),
      '-H',
      String(args.rect.height),
      '-Frames',
      String(args.frames),
      '-DelayMs',
      String(args.delayMs),
      '-Prefix',
      prefix
    ],
    { encoding: 'utf8', timeout: 60_000 }
  )
  const topWindowHandle = /TOP=(-?\d+)/.exec(output)?.[1] ?? ''
  const frames: Buffer[] = []
  for (let i = 0; i < args.frames; i++) {
    frames.push(readFileSync(`${prefix}-${i}.png`))
  }
  return {
    expectedWindowOnTop: topWindowHandle === args.expectedWindowHandle,
    topWindowHandle,
    frames
  }
}

/** Every frame differs from the one before — the surface kept turning over for the whole reading. */
export function framesKeptMoving(frames: Buffer[]): boolean {
  for (let i = 1; i < frames.length; i++) {
    if (frames[i].equals(frames[i - 1])) {
      return false
    }
  }
  return frames.length > 1
}
