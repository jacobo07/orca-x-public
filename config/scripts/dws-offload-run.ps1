<#
.SYNOPSIS
  DWS-P2 offload-run orchestrator (CTX-MEAS-1). Brackets a measured workload run: records free
  memory, runs the laptop process sampler for the run's lifetime, drives the opt-in Playwright
  evidence spec (tests/e2e/dws-offload-workload.spec.ts) against the real Orca desktop, then
  summarizes the captured samples against the manifest the spec itself writes.

.PARAMETER Target
  'local' runs the workload inside a terminal of the LOCAL desktop (this plan's baseline). Other
  values are accepted for future reuse but only 'local' is fully wired today.

.PARAMETER Legs
  One or more of test, build, agent. Passed through as ORCA_DWS_P2_LEGS (comma-joined).

.PARAMETER Checkout
  Path to the checkout the workload runs against (a `repo add` target).

.PARAMETER RunId
  Identifies this run's state directory under $env:LOCALAPPDATA\orca-dws-p2\runs\<RunId>\ — never
  committed, kept outside the repo (raw NDJSON/manifest are evidence artifacts, not source).
#>
param(
  [string]$Target = 'local',
  [string[]]$Legs = @('test', 'build'),
  [Parameter(Mandatory = $true)][string]$Checkout,
  [Parameter(Mandatory = $true)][string]$RunId
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Path (Split-Path -Path $PSScriptRoot -Parent) -Parent
$stateDir = Join-Path $env:LOCALAPPDATA "orca-dws-p2\runs\$RunId"
New-Item -ItemType Directory -Path $stateDir -Force | Out-Null

$ndjsonPath = Join-Path $stateDir 'samples.ndjson'
$stopFile = Join-Path $stateDir 'stop.flag'
$manifestPath = Join-Path $stateDir 'manifest.json'
$summaryPath = Join-Path $stateDir 'summary.json'

if (Test-Path $stopFile) {
  Remove-Item $stopFile -Force
}

function Get-FreeMb {
  $os = Get-CimInstance Win32_OperatingSystem
  return [math]::Round($os.FreePhysicalMemory / 1024, 1)
}

$freeBeforeMb = Get-FreeMb
Write-Output "DWS-P2-RUN state=$stateDir freeBeforeMb=$freeBeforeMb"

# --- Start the sampler, wait for its own sampler-start line before proceeding -------------------
$samplerScript = Join-Path $PSScriptRoot 'dws-laptop-process-sampler.ps1'
$samplerProc = Start-Process -FilePath 'powershell.exe' `
  -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $samplerScript, '-OutFile', $ndjsonPath, '-StopFile', $stopFile) `
  -PassThru -WindowStyle Hidden

$samplerStartDeadline = (Get-Date).AddSeconds(15)
$samplerStarted = $false
while ((Get-Date) -lt $samplerStartDeadline) {
  if ((Test-Path $ndjsonPath) -and ((Get-Content $ndjsonPath -Raw -ErrorAction SilentlyContinue) -match 'sampler-start')) {
    $samplerStarted = $true
    break
  }
  Start-Sleep -Milliseconds 200
}
if (-not $samplerStarted) {
  if (-not $samplerProc.HasExited) {
    Stop-Process -Id $samplerProc.Id -Force -ErrorAction SilentlyContinue
  }
  throw "Sampler did not emit a sampler-start line within 15s (pid=$($samplerProc.Id))"
}
Write-Output "DWS-P2-RUN samplerPid=$($samplerProc.Id) samplerStarted=true"

# --- Resolve the Playwright CLI, recording which form ran ---------------------------------------
& node (Join-Path $repoRoot 'config/scripts/ensure-native-runtime.mjs') --runtime=electron
if ($LASTEXITCODE -ne 0) {
  New-Item -ItemType File -Path $stopFile -Force | Out-Null
  throw "ensure-native-runtime.mjs --runtime=electron failed with exit $LASTEXITCODE"
}

$playwrightCliJs = Join-Path $repoRoot 'node_modules/@playwright/test/cli.js'
$playwrightCmdShim = Join-Path $repoRoot 'node_modules\.bin\playwright.cmd'
if (Test-Path $playwrightCliJs) {
  $pwCommand = 'node'
  $pwPrefixArgs = @($playwrightCliJs)
  $pwResolvedVia = 'node_modules/@playwright/test/cli.js'
} else {
  $pwCommand = $playwrightCmdShim
  $pwPrefixArgs = @()
  $pwResolvedVia = 'node_modules\.bin\playwright.cmd'
}
Write-Output "DWS-P2-RUN playwrightResolvedVia=$pwResolvedVia"

$grepPattern = if ($Target -eq 'local') { 'local workload' } else { 'desktop artifact answers status' }

$env:ORCA_DWS_P2_TARGET = $Target
$env:ORCA_DWS_P2_CHECKOUT = $Checkout
$env:ORCA_DWS_P2_LEGS = ($Legs -join ',')
$env:ORCA_DWS_P2_RUN_DIR = $stateDir

$pwArgs = $pwPrefixArgs + @(
  'test',
  '--config', 'tests/playwright.config.ts',
  '--project', 'electron-headless',
  '--workers=1',
  '--grep', $grepPattern
)

$pwExit = 1
Push-Location $repoRoot
try {
  & $pwCommand @pwArgs
  $pwExit = $LASTEXITCODE
} finally {
  Pop-Location
  Remove-Item Env:\ORCA_DWS_P2_TARGET -ErrorAction SilentlyContinue
  Remove-Item Env:\ORCA_DWS_P2_CHECKOUT -ErrorAction SilentlyContinue
  Remove-Item Env:\ORCA_DWS_P2_LEGS -ErrorAction SilentlyContinue
  Remove-Item Env:\ORCA_DWS_P2_RUN_DIR -ErrorAction SilentlyContinue
}

# --- Stop the sampler, record free memory AFTER --------------------------------------------------
New-Item -ItemType File -Path $stopFile -Force | Out-Null
$samplerExited = $samplerProc.WaitForExit(10000)
if (-not $samplerExited -and -not $samplerProc.HasExited) {
  Stop-Process -Id $samplerProc.Id -Force -ErrorAction SilentlyContinue
}

$freeAfterMb = Get-FreeMb

# --- Summarize -------------------------------------------------------------------------------
if (Test-Path $manifestPath) {
  & node (Join-Path $repoRoot 'config/scripts/dws-offload-measurement.mjs') summarize `
    --samples $ndjsonPath --manifest $manifestPath --out $summaryPath
} else {
  Write-Output "DWS-P2-RUN warning=manifest_missing path=$manifestPath (spec did not reach the manifest-write step)"
}

Write-Output "RUN=$RunId TARGET=$Target PLAYWRIGHT_EXIT=$pwExit FREE_BEFORE_MB=$freeBeforeMb FREE_AFTER_MB=$freeAfterMb SUMMARY=$summaryPath"
