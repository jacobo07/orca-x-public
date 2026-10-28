<#
Disposable GEX44 mobile runner (phase 18). Ships HEAD as a git bundle plus a tar of uncommitted
-Sync paths into /tmp/orca-phone-p18-<ts>, runs 18-gex44-mobile-vitest.sh there, then proves the
root is gone with a read-only check. Every deletion on GEX44 lives in the shipped .sh.

Example:
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File 18-gex44-mobile-vitest.ps1 -Mode test `
    -Sync mobile/src/a.ts,mobile/src/a.test.ts -Files src/a.test.ts
#>
param(
  [ValidateSet('test', 'full')][string]$Mode = 'test',
  [string[]]$Sync = @(),
  [string[]]$Files = @()
)

$ErrorActionPreference = 'Continue'
$repo = 'C:\owx-haf'
$git = 'C:\Program Files\Git\cmd\git.exe'
$target = 'gex44'

# -File passes "a,b" as one string, so split each element on commas.
$Sync = @($Sync | ForEach-Object { $_ -split ',' } | Where-Object { $_ -ne '' })
$Files = @($Files | ForEach-Object { $_ -split ',' } | Where-Object { $_ -ne '' })
if ($Files.Count -eq 0) { Write-Error 'No -Files given'; exit 2 }

$ts = (Get-Date).ToUniversalTime().ToString("yyyyMMdd'T'HHmmss'Z'")
$root = "/tmp/orca-phone-p18-$ts"
$tmp = Join-Path $env:TEMP "p18-$ts"
New-Item -ItemType Directory -Path $tmp -Force | Out-Null
Write-Output "LOCAL root=$root tmp=$tmp mode=$Mode"

$exit = 1
Push-Location $tmp
try {
  & $git -C $repo bundle create (Join-Path $tmp 'p18.bundle') HEAD 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'git bundle failed' }
  if ($Sync.Count -gt 0) {
    # Full path: from a Git Bash parent, PATH resolves tar.exe to MSYS tar, which reads C: as a host.
    & (Join-Path $env:SystemRoot 'System32\tar.exe') -C $repo -cf (Join-Path $tmp 'p18.tar') @Sync
    if ($LASTEXITCODE -ne 0) { throw 'tar failed' }
  }
  $shSource = Join-Path $PSScriptRoot '18-gex44-mobile-vitest.sh'
  $shText = [IO.File]::ReadAllText($shSource) -replace "`r`n", "`n"
  [IO.File]::WriteAllText((Join-Path $tmp 'run.sh'), $shText, (New-Object System.Text.UTF8Encoding($false)))

  & ssh -o BatchMode=yes $target "mkdir -p $root"
  if ($LASTEXITCODE -ne 0) { throw 'ssh mkdir failed' }
  $upload = @('p18.bundle', 'run.sh')
  if (Test-Path (Join-Path $tmp 'p18.tar')) { $upload += 'p18.tar' }
  & scp -q -o BatchMode=yes @upload "${target}:$root/"
  if ($LASTEXITCODE -ne 0) { throw 'scp failed' }

  $lines = New-Object System.Collections.Generic.List[string]
  & ssh -o BatchMode=yes $target bash "$root/run.sh" $root $Mode @Files 2>&1 | ForEach-Object {
    $line = "$_"
    $lines.Add($line)
    Write-Output $line
  }
  $exit = $LASTEXITCODE
  $teardownSeen = $lines -match '^TEARDOWN procs=\d+ root=absent$'
  if (-not $teardownSeen) { Write-Output 'LOCAL missing TEARDOWN root=absent line'; $exit = 4 }
} catch {
  Write-Output "LOCAL error: $_"
  $exit = 1
} finally {
  Pop-Location
  $proof = & ssh -o BatchMode=yes $target "test ! -e $root && echo ROOT_ABSENT_CONFIRMED"
  Write-Output "PROOF $proof"
  if ("$proof" -notmatch 'ROOT_ABSENT_CONFIRMED') {
    Write-Output "LOCAL root $root still present or unproven"
    if ($exit -eq 0) { $exit = 5 }
  }
  Remove-Item -Recurse -Force -LiteralPath $tmp -ErrorAction SilentlyContinue
}
Write-Output "LOCAL exit=$exit"
exit $exit
