<#
Disposable GEX44 build of out/ at HEAD (phase 19). Ships HEAD as a git bundle into /tmp/orca-phone-p19-<ts>,
runs 19-gex44-build-out.sh there (fed on stdin as a no-BOM LF file), copies out.tgz back, compares sha256 on
both ends, extracts only out/ into the repo (gitignored), then tears the root down and prints the NONE_P19 proof.
Every deletion on GEX44 lives in the shipped .sh.

Example:
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File 19-gex44-build-out.ps1
#>
param([string]$PreviousOutDir = '')

$ErrorActionPreference = 'Continue'
$repo = 'C:\owx-haf'
$git = 'C:\Program Files\Git\cmd\git.exe'
$tarExe = Join-Path $env:SystemRoot 'System32\tar.exe'
$target = 'gex44'

$ts = (Get-Date).ToUniversalTime().ToString("yyyyMMdd'T'HHmmss'Z'")
$root = "/tmp/orca-phone-p19-$ts"
$tmp = Join-Path $env:TEMP "p19-$ts"
New-Item -ItemType Directory -Path $tmp -Force | Out-Null
$head = (& $git -C $repo rev-parse HEAD).Trim()
Write-Output "LOCAL root=$root tmp=$tmp head=$head"

function Invoke-Runner([string]$mode) {
  $sh = Join-Path $tmp 'run.sh'
  & cmd /c "ssh -o BatchMode=yes $target bash -s -- $mode $root < `"$sh`"" 2>&1 | ForEach-Object { "$_" }
}

$exit = 1
try {
  & $git -C $repo bundle create (Join-Path $tmp 'p19.bundle') HEAD 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'git bundle failed' }
  $shText = [IO.File]::ReadAllText((Join-Path $PSScriptRoot '19-gex44-build-out.sh')) -replace "`r`n", "`n"
  [IO.File]::WriteAllText((Join-Path $tmp 'run.sh'), $shText, (New-Object System.Text.UTF8Encoding($false)))

  & ssh -o BatchMode=yes $target "mkdir -p $root"
  if ($LASTEXITCODE -ne 0) { throw 'ssh mkdir failed' }
  & scp -q -o BatchMode=yes (Join-Path $tmp 'p19.bundle') "${target}:$root/"
  if ($LASTEXITCODE -ne 0) { throw 'scp bundle failed' }

  $lines = @(Invoke-Runner 'build')
  $lines | ForEach-Object { Write-Output $_ }
  $remoteSha = ($lines | Where-Object { $_ -match '^SHA256_REMOTE [0-9a-f]{64}$' } | Select-Object -First 1)
  $builtHead = ($lines | Where-Object { $_ -match '^RUNNER head=' } | Select-Object -First 1)
  if (-not $remoteSha) { throw 'remote build did not print SHA256_REMOTE' }
  if ("$builtHead" -ne "RUNNER head=$head") { throw "built head mismatch: $builtHead vs $head" }
  $remoteSha = $remoteSha.Substring('SHA256_REMOTE '.Length)

  $tgz = Join-Path $tmp 'out.tgz'
  & scp -q -o BatchMode=yes "${target}:$root/out.tgz" $tgz
  if ($LASTEXITCODE -ne 0) { throw 'scp out.tgz back failed' }
  $localSha = (Get-FileHash -Algorithm SHA256 -LiteralPath $tgz).Hash.ToLower()
  Write-Output "SHA256 remote=$remoteSha local=$localSha"
  if ($localSha -ne $remoteSha) { throw 'sha256 mismatch' }

  $entries = @(& $tarExe -tzf $tgz)
  $foreign = @($entries | Where-Object { $_ -notmatch '^out(/|$)' -or $_ -match '(^|/)\.\.(/|$)' })
  if ($foreign.Count -gt 0) { throw "out.tgz holds entries outside out/: $($foreign[0])" }
  Write-Output "LOCAL out_entries=$($entries.Count)"
  $outDir = Join-Path $repo 'out'
  if (Test-Path -LiteralPath $outDir) {
    # Why move, not delete: the previous build output stays recoverable until the caller discards it.
    $prev = if ($PreviousOutDir) { $PreviousOutDir } else { Join-Path $tmp 'out.prev' }
    Move-Item -LiteralPath $outDir -Destination $prev
    Write-Output "LOCAL previous out/ moved to $prev"
  }
  & $tarExe -xzf $tgz -C $repo out
  if ($LASTEXITCODE -ne 0) { throw 'extract failed' }
  Write-Output "LOCAL extracted out/ built from $head"
  $exit = 0
} catch {
  Write-Output "LOCAL error: $_"
  $exit = 1
} finally {
  $down = @(Invoke-Runner 'teardown')
  $down | ForEach-Object { Write-Output $_ }
  $proof = & ssh -o BatchMode=yes $target "ls /tmp | grep orca-phone-p19 || echo NONE_P19"
  Write-Output "PROOF_AFTER $proof"
  if ("$proof" -notmatch 'NONE_P19') {
    Write-Output "LOCAL root $root still present or unproven"
    if ($exit -eq 0) { $exit = 5 }
  }
  Remove-Item -LiteralPath (Join-Path $tmp 'p19.bundle'), (Join-Path $tmp 'out.tgz'), (Join-Path $tmp 'run.sh') -Force -ErrorAction SilentlyContinue
}
Write-Output "LOCAL exit=$exit"
exit $exit
