# What does DWM hold as the SOURCE of each window's thumbnail, right now?
#
# One call answers the question the whole taskbar investigation turns on. DwmQueryThumbnailSourceSize
# reports the real window rect when DWM composites the window's own surface, and the size of the last
# supplied iconic bitmap (250x148 for a taskbar thumbnail) when the app has taken the representation
# over. Those are different worlds with different fixes, and nothing on the supply side can tell them
# apart -- an HRESULT of zero is returned in both.
#
# Deliberately non-intrusive, because the owner of this machine is using it:
#   * the destination window is never shown -- touching .Handle creates the HWND and nothing paints,
#     so no focus is stolen, no pixels are covered, and no pointer is moved;
#   * nothing is minimized, restored, activated or closed;
#   * no pixels are sampled, so it costs one process for well under a second.
#
# Every visible top-level window is measured, not only the subject. A reading of 250x148 means
# nothing without a window in the same sample reporting its real rect: that is the control which
# proves the instrument can return the other answer.

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -Namespace Q -Name W -MemberDefinition @'
[StructLayout(LayoutKind.Sequential)] public struct SIZE { public int cx, cy; }
[StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }
[DllImport("dwmapi.dll")] public static extern int DwmRegisterThumbnail(IntPtr dest, IntPtr src, out IntPtr id);
[DllImport("dwmapi.dll")] public static extern int DwmUnregisterThumbnail(IntPtr id);
[DllImport("dwmapi.dll")] public static extern int DwmQueryThumbnailSourceSize(IntPtr id, out SIZE s);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
'@

[void][Q.W]::SetProcessDPIAware()

# Never shown. Reading .Handle is what creates the window; Show() is what would activate it.
$host_ = New-Object System.Windows.Forms.Form
$dest = $host_.Handle

$rows = @()
foreach ($p in Get-Process | Where-Object { $_.MainWindowHandle -ne 0 }) {
  $h = $p.MainWindowHandle
  if (-not [Q.W]::IsWindowVisible($h)) { continue }

  $thumb = [IntPtr]::Zero
  $hr = [Q.W]::DwmRegisterThumbnail($dest, $h, [ref]$thumb)
  $size = New-Object Q.W+SIZE
  if ($hr -eq 0) {
    [void][Q.W]::DwmQueryThumbnailSourceSize($thumb, [ref]$size)
    [void][Q.W]::DwmUnregisterThumbnail($thumb)
  }
  $r = New-Object Q.W+RECT
  [void][Q.W]::GetWindowRect($h, [ref]$r)

  $rows += [pscustomobject]@{
    Process   = $p.ProcessName
    Pid       = $p.Id
    Title     = if ($p.MainWindowTitle.Length -gt 34) { $p.MainWindowTitle.Substring(0, 34) } else { $p.MainWindowTitle }
    Hresult   = $hr
    ThumbSrc  = "$($size.cx)x$($size.cy)"
    WindowRect = "$($r.R - $r.L)x$($r.B - $r.T)"
    Iconic    = [bool][Q.W]::IsIconic($h)
  }
}

$host_.Dispose()
$rows | Sort-Object Process | Format-Table -AutoSize
