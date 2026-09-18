# What does DWM hold as the SOURCE of one window's taskbar thumbnail, right now?
#
# DwmQueryThumbnailSourceSize reports the window's real rect while DWM composites the window's own
# surface, and the size of the last supplied iconic bitmap once the app has taken the representation
# over. Those are opposite worlds -- one is the platform's live composition, the other is a picture
# we drew -- and nothing on the supply side tells them apart, because a successful supply returns
# HRESULT zero in both.
#
# Keyed to an HWND, which is what makes it an exact-target instrument: a browser window aligned with
# the taskbar, the tray's hidden-icons flyout and a tooltip all pass a geometric test for "a popup
# above the taskbar" and none of them can pass this one, because none of them is the window.
#
# Deliberately non-intrusive, because the machine may be in use: the destination window is never
# shown (touching .Handle creates the HWND and nothing paints), nothing is minimized, restored,
# activated or closed here, no pointer moves, and no pixels are sampled.

param(
  [Parameter(Mandatory = $true)][long]$Hwnd
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -Namespace S -Name W -MemberDefinition @'
[StructLayout(LayoutKind.Sequential)] public struct SIZE { public int cx, cy; }
[StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }
[DllImport("dwmapi.dll")] public static extern int DwmRegisterThumbnail(IntPtr dest, IntPtr src, out IntPtr id);
[DllImport("dwmapi.dll")] public static extern int DwmUnregisterThumbnail(IntPtr id);
[DllImport("dwmapi.dll")] public static extern int DwmQueryThumbnailSourceSize(IntPtr id, out SIZE s);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
[DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
'@

# Without this the rects come back in virtual pixels while DWM answers in physical ones, and the two
# would disagree by the display scale alone -- a difference that reads exactly like a takeover.
[void][S.W]::SetProcessDPIAware()

$target = [IntPtr]::new($Hwnd)
if (-not [S.W]::IsWindow($target)) {
  Write-Output (ConvertTo-Json -Compress @{ status = 'no-window' })
  exit 0
}

$destForm = New-Object System.Windows.Forms.Form
$thumb = [IntPtr]::Zero
$hr = [S.W]::DwmRegisterThumbnail($destForm.Handle, $target, [ref]$thumb)

$source = New-Object S.W+SIZE
if ($hr -eq 0) {
  [void][S.W]::DwmQueryThumbnailSourceSize($thumb, [ref]$source)
  [void][S.W]::DwmUnregisterThumbnail($thumb)
}

$rect = New-Object S.W+RECT
[void][S.W]::GetWindowRect($target, [ref]$rect)

Write-Output (ConvertTo-Json -Compress @{
    status       = 'measured'
    hresult      = $hr
    sourceWidth  = $source.cx
    sourceHeight = $source.cy
    rectWidth    = $rect.R - $rect.L
    rectHeight   = $rect.B - $rect.T
    iconic       = [bool][S.W]::IsIconic($target)
  })
