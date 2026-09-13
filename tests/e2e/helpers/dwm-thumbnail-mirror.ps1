# Read what DWM actually holds for a window, without touching the user's pointer or focus.
#
# The taskbar flyout is a DWM thumbnail. DwmRegisterThumbnail draws that same representation into a
# window of our own, so the visible representation can be sampled repeatedly and compared. Hovering
# the real taskbar button would measure the same surface but requires exclusive control of the mouse,
# which is not available on a machine somebody is using -- and a synthetic pointer fights them.
#
# Prints one JSON object. Frames carry a content hash and the source window's iconic state, so a run
# that stopped being minimized is reported as such rather than as a frozen preview: those two produce
# identical readings and only one of them is about the product.

param(
  [Parameter(Mandatory = $true)][long]$Hwnd,
  [int]$Frames = 6,
  [int]$IntervalMs = 3000,
  [int]$Width = 640,
  [int]$Height = 380,
  [string]$OutDir = ''
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -Namespace D -Name W -MemberDefinition @'
[StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }
[StructLayout(LayoutKind.Sequential)] public struct SIZE { public int cx, cy; }
[StructLayout(LayoutKind.Sequential)] public struct PROPS {
  public int dwFlags; public RECT rcDestination; public RECT rcSource;
  public byte opacity; public bool fVisible; public bool fSourceClientAreaOnly; }
[DllImport("dwmapi.dll")] public static extern int DwmRegisterThumbnail(IntPtr dest, IntPtr src, out IntPtr id);
[DllImport("dwmapi.dll")] public static extern int DwmUpdateThumbnailProperties(IntPtr id, ref PROPS p);
[DllImport("dwmapi.dll")] public static extern int DwmUnregisterThumbnail(IntPtr id);
[DllImport("dwmapi.dll")] public static extern int DwmQueryThumbnailSourceSize(IntPtr id, out SIZE s);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
'@

# Without this the form's logical coordinates and the screen's physical pixels disagree on a scaled
# display, so the capture rectangle misses the client area and the mirror's own chrome lands inside
# the frame -- which reads as unpainted bands in the thumbnail. Measured: it produced exactly the
# letterboxing artifact that the product was briefly accused of.
[void][D.W]::SetProcessDPIAware()

$source = [IntPtr]$Hwnd
$form = New-Object System.Windows.Forms.Form
# Borderless is a control, not a cosmetic choice: with no title bar and no border, a band inside a
# captured frame cannot be the mirror's own chrome.
$form.FormBorderStyle = 'None'
$form.StartPosition = 'Manual'
$form.Location = New-Object System.Drawing.Point(0, 0)
$form.ClientSize = New-Object System.Drawing.Size($Width, $Height)
# Any magenta surviving into a frame is mirror background DWM never drew over.
$form.BackColor = [System.Drawing.Color]::Magenta
$form.TopMost = $true
$form.Show()
[System.Windows.Forms.Application]::DoEvents()
Start-Sleep -Milliseconds 400

$thumb = [IntPtr]::Zero
$registerHr = [D.W]::DwmRegisterThumbnail($form.Handle, $source, [ref]$thumb)
if ($registerHr -ne 0) {
  $form.Close()
  Write-Output (@{ registerHresult = $registerHr; frames = @() } | ConvertTo-Json -Compress)
  exit 0
}

$srcSize = New-Object D.W+SIZE
[void][D.W]::DwmQueryThumbnailSourceSize($thumb, [ref]$srcSize)

$props = New-Object D.W+PROPS
$rect = New-Object D.W+RECT
$rect.L = 0; $rect.T = 0; $rect.R = $Width; $rect.B = $Height
$props.dwFlags = 0x1 -bor 0x4 -bor 0x8    # DESTINATION | OPACITY | VISIBLE
$props.rcDestination = $rect
$props.opacity = 255
$props.fVisible = $true
$props.fSourceClientAreaOnly = $false

$iconicAtStart = [D.W]::IsIconic($source)
$captured = @()
for ($f = 0; $f -lt $Frames; $f++) {
  [void][D.W]::DwmUpdateThumbnailProperties($thumb, [ref]$props)
  [System.Windows.Forms.Application]::DoEvents()
  Start-Sleep -Milliseconds $IntervalMs
  [System.Windows.Forms.Application]::DoEvents()

  $bmp = New-Object System.Drawing.Bitmap $Width, $Height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $origin = $form.PointToScreen((New-Object System.Drawing.Point(0, 0)))
  $g.CopyFromScreen($origin.X, $origin.Y, 0, 0, (New-Object System.Drawing.Size($Width, $Height)))
  $g.Dispose()

  if ($OutDir -ne '') {
    if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Force -Path $OutDir | Out-Null }
    $bmp.Save((Join-Path $OutDir "thumbnail-$f.png"), [System.Drawing.Imaging.ImageFormat]::Png)
  }

  # Three quantities, because "blank" has three different shapes and one measure catches only one.
  #
  # `unpainted` finds mirror background DWM never drew over. It cannot see an all-black thumbnail,
  # because black is a colour DWM did draw -- so a check built on it alone passes the exact failure
  # it exists to catch.
  #
  # `nearBlack` closes that, but only loosely: a dark theme is legitimately dark, and a fixed
  # darkness threshold sits uncomfortably close to the value a correct dark window produces. It is
  # reported for diagnosis rather than trusted as a gate.
  #
  # `distinctColours` is the one that cannot be fooled by a theme. A real window preview -- light or
  # dark -- carries text, chrome and edges worth thousands of quantised colours; an empty surface
  # carries one, whatever its brightness. Quantised to 5 bits per channel so JPEG-ish gradients and
  # subpixel antialiasing do not inflate the count.
  $hash = 0; $unpainted = 0; $nearBlack = 0; $sampled = 0
  $palette = New-Object 'System.Collections.Generic.HashSet[int]'
  for ($y = 0; $y -lt $Height; $y += 4) {
    for ($x = 0; $x -lt $Width; $x += 4) {
      $c = $bmp.GetPixel($x, $y)
      $sampled++
      if ($c.R -gt 240 -and $c.G -lt 20 -and $c.B -gt 240) { $unpainted++ }
      elseif ($c.R -lt 24 -and $c.G -lt 24 -and $c.B -lt 24) { $nearBlack++ }
      [void]$palette.Add((([int]$c.R -shr 3) -shl 10) -bor (([int]$c.G -shr 3) -shl 5) -bor ([int]$c.B -shr 3))
      $hash = ($hash * 31 + $c.R * 3 + $c.G * 5 + $c.B * 7) % 1000003
    }
  }
  $bmp.Dispose()
  $captured += [ordered]@{
    index = $f
    hash = $hash
    unpaintedPct = [math]::Round(100 * $unpainted / $sampled, 2)
    nearBlackPct = [math]::Round(100 * $nearBlack / $sampled, 2)
    distinctColours = $palette.Count
    iconic = [bool][D.W]::IsIconic($source)
  }
}
$iconicAtEnd = [D.W]::IsIconic($source)

[void][D.W]::DwmUnregisterThumbnail($thumb)
$form.Close()

Write-Output (@{
  registerHresult = $registerHr
  sourceWidth     = $srcSize.cx
  sourceHeight    = $srcSize.cy
  iconicAtStart   = [bool]$iconicAtStart
  iconicAtEnd     = [bool]$iconicAtEnd
  frames          = $captured
} | ConvertTo-Json -Depth 4 -Compress)
