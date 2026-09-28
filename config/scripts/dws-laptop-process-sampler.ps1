<#
.SYNOPSIS
  DWS-P2 laptop-side process/memory sampler (CTX-MEAS-1/2). Companion to
  config/scripts/dws-offload-measurement.mjs, which is the analysis half.

.DESCRIPTION
  Samples Win32_OperatingSystem (free/total physical memory) and Win32_Process
  (ProcessId, ParentProcessId, Name, WorkingSetSize, CreationDate, CommandLine) at a
  target 1s cadence, redacts any pairing-code material from CommandLine BEFORE it
  ever touches disk (defense-in-depth: the analysis module's parseSamples() redacts
  again on read -- T-02-04b), and appends one compact JSON line per sample to -OutFile
  using a BOM-free UTF-8 encoder (PowerShell 5.1's own `-Encoding UTF8` on
  Add-Content/Out-File prepends a BOM that breaks JSON.parse on the first line --
  "the parser is part of the guard").

  Emits a `sampler-start` line before the first sample and a `sampler-stop` line
  after the last, so a consumer can see the sampler's own pid/interval/host without
  guessing from the sample stream.

.PARAMETER OutFile
  NDJSON output path. Required unless -SelfTest.

.PARAMETER IntervalMs
  Target sampling cadence in milliseconds. Default 1000 (CTX-MEAS-1's "1s cadence").

.PARAMETER DurationSeconds
  Stop after this many seconds. 0 (default) means "run until -StopFile appears" --
  the caller is then responsible for writing that file to end the run.

.PARAMETER StopFile
  Path to a sentinel file; the sampler stops once this file exists.

.PARAMETER SelfTest
  Runs an 8-second sampling window against two real, deliberately-spawned `node`
  processes (a nonce-carrying smoke process and a fake-pairing-code process), then
  invokes the analysis module's `summarize` CLI against the captured NDJSON and
  asserts: (1) the smoke process was classified as workload via the nonce (the
  positive control that identity attribution actually fires), (2) the fake pairing
  code string is absent from the NDJSON (redaction proven on real data, not just
  synthetic fixtures), (3) an observed cadence is reported. Prints
  `SAMPLER_SELFTEST=PASS observedCadenceMs=<n>` or `SAMPLER_SELFTEST=FAIL reason=<...>`
  and stops both dummy processes by their recorded PIDs in a finally block
  regardless of outcome.
#>
param(
  [string]$OutFile,
  [int]$IntervalMs = 1000,
  [int]$DurationSeconds = 0,
  [string]$StopFile,
  [switch]$SelfTest
)

$ErrorActionPreference = 'Stop'

function Redact-CommandLine {
  param([string]$CommandLine)
  if ([string]::IsNullOrEmpty($CommandLine)) {
    return $CommandLine
  }
  $result = $CommandLine
  $ignoreCase = [System.Text.RegularExpressions.RegexOptions]::IgnoreCase
  $result = [regex]::Replace($result, 'orca://pair\?\S*', '<redacted>', $ignoreCase)
  $result = [regex]::Replace($result, '--pairing-code[= ]+\S+', '<redacted>', $ignoreCase)
  $result = [regex]::Replace($result, 'ORCA_PAIRING_CODE=\S+', '<redacted>', $ignoreCase)
  return $result
}

function Write-Utf8NoBomLine {
  param([string]$Path, [string]$Line)
  # Why AppendAllText + an explicit no-BOM encoder, never Add-Content -Encoding UTF8: PS 5.1's
  # own UTF8 encoding cmdlets prepend a BOM (U+FEFF), which breaks JSON.parse on the first line.
  [System.IO.File]::AppendAllText($Path, $Line + "`n", (New-Object System.Text.UTF8Encoding($false)))
}

function Get-FreeMemorySnapshotMb {
  $os = Get-CimInstance Win32_OperatingSystem
  # FreePhysicalMemory/TotalVisibleMemorySize are natively KB per the WMI class docs.
  [PSCustomObject]@{
    FreeMb  = [math]::Round($os.FreePhysicalMemory / 1024, 2)
    TotalMb = [math]::Round($os.TotalVisibleMemorySize / 1024, 2)
  }
}

function Get-ProcessSnapshot {
  Get-CimInstance Win32_Process | ForEach-Object {
    $creation = $null
    if ($_.CreationDate) {
      $creation = $_.CreationDate.ToUniversalTime().ToString('o')
    }
    [PSCustomObject]@{
      pid          = $_.ProcessId
      ppid         = $_.ParentProcessId
      name         = $_.Name
      workingSetMb = [math]::Round($_.WorkingSetSize / 1MB, 3)
      creationDate = $creation
      commandLine  = Redact-CommandLine $_.CommandLine
    }
  }
}

function Write-OneSample {
  param([string]$Path, [System.Diagnostics.Stopwatch]$Stopwatch)
  $mem = Get-FreeMemorySnapshotMb
  $procs = Get-ProcessSnapshot
  $sample = [ordered]@{
    kind    = 'sample'
    utc     = (Get-Date).ToUniversalTime().ToString('o')
    monoMs  = $Stopwatch.ElapsedMilliseconds
    freeMb  = $mem.FreeMb
    totalMb = $mem.TotalMb
    procs   = @($procs)
  }
  $json = $sample | ConvertTo-Json -Compress -Depth 6
  Write-Utf8NoBomLine -Path $Path -Line $json
}

function Invoke-SamplingLoop {
  param([string]$Path, [int]$IntervalMsLocal, [int]$DurationSecondsLocal, [string]$StopFileLocal)

  if ([string]::IsNullOrEmpty($Path)) {
    throw '-OutFile is required'
  }
  $parent = Split-Path -Path $Path -Parent
  if ($parent -and -not (Test-Path $parent)) {
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
  }
  if (Test-Path $Path) {
    Remove-Item $Path -Force
  }

  $samplerPid = $PID
  $startUtc = (Get-Date).ToUniversalTime().ToString('o')
  Write-Utf8NoBomLine -Path $Path -Line (
    ([ordered]@{
      kind       = 'sampler-start'
      samplerPid = $samplerPid
      intervalMs = $IntervalMsLocal
      host       = $env:COMPUTERNAME
      utc        = $startUtc
    } | ConvertTo-Json -Compress)
  )

  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $endTime = $null
  if ($DurationSecondsLocal -gt 0) {
    $endTime = (Get-Date).AddSeconds($DurationSecondsLocal)
  }

  while ($true) {
    $iterStartMs = $sw.ElapsedMilliseconds
    Write-OneSample -Path $Path -Stopwatch $sw

    $shouldStop = $false
    if ($StopFileLocal -and (Test-Path $StopFileLocal)) {
      $shouldStop = $true
    }
    if ($endTime -and (Get-Date) -ge $endTime) {
      $shouldStop = $true
    }
    if ($shouldStop) {
      break
    }

    $elapsedMs = $sw.ElapsedMilliseconds - $iterStartMs
    $remainingMs = $IntervalMsLocal - $elapsedMs
    if ($remainingMs -gt 0) {
      Start-Sleep -Milliseconds $remainingMs
    }
  }

  Write-Utf8NoBomLine -Path $Path -Line (
    ([ordered]@{
      kind       = 'sampler-stop'
      samplerPid = $samplerPid
      utc        = (Get-Date).ToUniversalTime().ToString('o')
    } | ConvertTo-Json -Compress)
  )
}

if ($SelfTest) {
  $nonce = "SELFTEST-$([guid]::NewGuid().ToString('N').Substring(0, 12))"
  $stateDir = Join-Path $env:LOCALAPPDATA 'orca-dws-p2'
  New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
  $selfTestOut = Join-Path $stateDir "sampler-selftest-$nonce.ndjson"
  $manifestPath = Join-Path $stateDir "sampler-selftest-$nonce-manifest.json"
  $summaryOutPath = Join-Path $stateDir "sampler-selftest-$nonce-summary.json"

  $smokeProc = $null
  $fakeProc = $null
  $exitCode = 1
  try {
    $smokeProc = Start-Process -FilePath 'node' -ArgumentList @('-e', 'setTimeout(()=>{},9000)', "DWS-P2-SMOKE-$nonce") -PassThru -WindowStyle Hidden
    $fakeProc = Start-Process -FilePath 'node' -ArgumentList @('-e', 'setTimeout(()=>{},9000)', "orca://pair?code=DWS-FAKE-$nonce") -PassThru -WindowStyle Hidden

    # Sample for 8s against the real, running dummy processes -- never a synthetic fixture --
    # so the positive control (nonce attribution actually firing) and the redaction proof
    # (DWS-FAKE absent from the NDJSON) are both observed on real Win32_Process data.
    Invoke-SamplingLoop -Path $selfTestOut -IntervalMsLocal $IntervalMs -DurationSecondsLocal 8 -StopFileLocal $null

    $manifest = [ordered]@{
      desktopRootPid  = 0
      nonce           = $nonce
      harnessRootPids = @($PID)
    }
    ($manifest | ConvertTo-Json -Compress) | Out-File -FilePath $manifestPath -Encoding ascii -NoNewline

    $moduleScript = Join-Path (Split-Path -Path $PSCommandPath -Parent) 'dws-offload-measurement.mjs'
    $summarizeOutput = & node $moduleScript summarize --samples $selfTestOut --manifest $manifestPath --out $summaryOutPath 2>&1
    $summarizeExit = $LASTEXITCODE

    if ($summarizeExit -ne 0) {
      Write-Output "SAMPLER_SELFTEST=FAIL reason=summarize_exit_$summarizeExit output=$summarizeOutput"
      $exitCode = 1
    } else {
      $ndjsonBytes = [System.IO.File]::ReadAllBytes($selfTestOut)
      $firstByteIsBrace = ($ndjsonBytes.Length -gt 0) -and ([char]$ndjsonBytes[0] -eq '{')
      $ndjsonText = [System.IO.File]::ReadAllText($selfTestOut, [System.Text.Encoding]::UTF8)
      $containsFake = $ndjsonText.Contains('DWS-FAKE')

      $summary = Get-Content $summaryOutPath -Raw | ConvertFrom-Json
      $nonceFamily = $summary.perFamily.nonce
      $positiveControlFired = $nonceFamily -and ($nonceFamily.maxCount -ge 1)
      $observedCadence = $summary.cadence.medianMs

      if (-not $firstByteIsBrace) {
        Write-Output 'SAMPLER_SELFTEST=FAIL reason=first_byte_not_brace_bom_suspected'
        $exitCode = 1
      } elseif ($containsFake) {
        Write-Output 'SAMPLER_SELFTEST=FAIL reason=DWS-FAKE_found_in_ndjson_redaction_broken'
        $exitCode = 1
      } elseif (-not $positiveControlFired) {
        Write-Output 'SAMPLER_SELFTEST=FAIL reason=nonce_positive_control_did_not_fire'
        $exitCode = 1
      } else {
        Write-Output "SAMPLER_SELFTEST=PASS observedCadenceMs=$observedCadence"
        $exitCode = 0
      }
    }
  } catch {
    Write-Output "SAMPLER_SELFTEST=FAIL reason=exception:$($_.Exception.Message)"
    $exitCode = 1
  } finally {
    if ($smokeProc -and -not $smokeProc.HasExited) {
      Stop-Process -Id $smokeProc.Id -Force -ErrorAction SilentlyContinue
    }
    if ($fakeProc -and -not $fakeProc.HasExited) {
      Stop-Process -Id $fakeProc.Id -Force -ErrorAction SilentlyContinue
    }
  }
  exit $exitCode
}

Invoke-SamplingLoop -Path $OutFile -IntervalMsLocal $IntervalMs -DurationSecondsLocal $DurationSeconds -StopFileLocal $StopFile
