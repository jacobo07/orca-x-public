<#
.SYNOPSIS
  DWS-P2 offload-run orchestrator (CTX-MEAS-1). Brackets a measured workload run: records free
  memory, runs the laptop process sampler for the run's lifetime, drives the opt-in Playwright
  evidence spec (tests/e2e/dws-offload-workload.spec.ts) against the real Orca desktop, then
  summarizes the captured samples against the manifest the spec itself writes.

.PARAMETER Target
  'local' runs the workload inside a terminal of the LOCAL desktop (this plan's baseline).
  'remote' runs it through the paired GEX44 environment, bracketing a remote `ps --forest`
  capture around the sweep and judging the result via `dws-offload-measurement.mjs remote-proof`.

.PARAMETER Legs
  One or more of test, build, agent. Passed through as ORCA_DWS_P2_LEGS (comma-joined).

.PARAMETER Checkout
  Path to the checkout the workload runs against (a `repo add` target). In -Target remote mode this
  is OPTIONAL: when omitted, it is read from deployed.json's `svcCheckout` (written by
  Publish-DwsServeBuild) rather than hard-coded by the caller.

.PARAMETER RunId
  Identifies this run's state directory under $env:LOCALAPPDATA\orca-dws-p2\runs\<RunId>\ — never
  committed, kept outside the repo (raw NDJSON/manifest are evidence artifacts, not source).

.PARAMETER PairingFile
  (remote only) Path to a throwaway `{ pairing: { pairingUrl, pairingSha12 } }` file — required.

.PARAMETER EnvName
  (remote only) The paired runtime environment's display name. Default gex44-svc.

.PARAMETER SvcSha
  (remote only) The git SHA of the GEX44 service checkout the workload legs actually run against.

.PARAMETER BaselineManifest
  (remote only) Path to the accepted LOCAL baseline's manifest.json, for the blob-hash comparability
  refusal. Optional — if omitted, blobHashesMatchBaseline is recorded as 'no-baseline-manifest'.

.PARAMETER AgentKind / AgentBin
  (remote only) Forwarded to the agent leg's dispatch when 'agent' is in -Legs.

.PARAMETER CaptureCount / CaptureIntervalSec
  (remote only) `ps-capture <count> <interval>` on GEX44 — one CAPTURE block per interval. Default
  600 x 3s = 30 minutes of coverage; raise for a longer expected sweep (agent leg especially).
#>
param(
  [string]$Target = 'local',
  [string[]]$Legs = @('test', 'build'),
  [string]$Checkout,
  [Parameter(Mandatory = $true)][string]$RunId,
  [string]$PairingFile,
  [string]$EnvName = 'gex44-svc',
  [string]$SvcSha,
  [string]$BaselineManifest,
  [string]$AgentKind,
  [string]$AgentBin,
  [int]$CaptureCount = 600,
  [int]$CaptureIntervalSec = 3
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Path (Split-Path -Path $PSScriptRoot -Parent) -Parent
$stateDir = Join-Path $env:LOCALAPPDATA "orca-dws-p2\runs\$RunId"
New-Item -ItemType Directory -Path $stateDir -Force | Out-Null

$ndjsonPath = Join-Path $stateDir 'samples.ndjson'
$stopFile = Join-Path $stateDir 'stop.flag'
$manifestPath = Join-Path $stateDir 'manifest.json'
$summaryPath = Join-Path $stateDir 'summary.json'
$remotePsPath = Join-Path $stateDir 'remote-ps.txt'
$remoteProofPath = Join-Path $stateDir 'remote-proof.json'

if (Test-Path $stopFile) {
  Remove-Item $stopFile -Force
}

# Why: a rerun under the same RunId must never summarize or judge the previous run's manifest,
# proof or capture (and the sampler appends, so old samples would merge in). Moved, not deleted.
$priorArtifacts = @($ndjsonPath, $manifestPath, $summaryPath, $remotePsPath, $remoteProofPath) |
  Where-Object { Test-Path -LiteralPath $_ }
if ($priorArtifacts) {
  $supersededDir = Join-Path $stateDir ('superseded-' + (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssfffZ'))
  New-Item -ItemType Directory -Path $supersededDir -Force | Out-Null
  foreach ($priorArtifact in $priorArtifacts) {
    Move-Item -LiteralPath $priorArtifact -Destination $supersededDir
  }
  Write-Output "DWS-P2-RUN supersededPriorArtifacts=$supersededDir count=$(@($priorArtifacts).Count)"
}

if ($Target -eq 'local' -and -not $Checkout) {
  throw "dws-offload-run.ps1 -Target local requires -Checkout"
}

if ($Target -eq 'remote') {
  if (-not $PairingFile) {
    throw "dws-offload-run.ps1 -Target remote requires -PairingFile"
  }
  Import-Module (Join-Path $PSScriptRoot 'dws-laptop-remote.psm1') -Force

  # Acceptance criteria (02-05 Task 2): the service checkout is taken from deployed.json, never
  # hard-coded by the caller, and the run refuses when deployed.json's sha disagrees with what the
  # systemd unit's WorkingDirectory is ACTUALLY checked out to on GEX44 -- deployed.json is this
  # process's own state cache and can go stale if someone redeploys outside Publish-DwsServeBuild.
  $deployedJsonPath = Join-Path (Get-DwsStateDir) 'deployed.json'
  if (-not (Test-Path $deployedJsonPath)) {
    throw "dws-offload-run.ps1 -Target remote: $deployedJsonPath not found -- run Publish-DwsServeBuild first"
  }
  $deployed = Get-Content $deployedJsonPath -Raw | ConvertFrom-Json
  if (-not $Checkout) {
    $Checkout = $deployed.svcCheckout
  }
  if (-not $SvcSha) {
    $SvcSha = $deployed.sha
  }
  $workingDirResult = Invoke-DwsSsh -RemoteBody 'systemctl show orca-dws-serve.service -p WorkingDirectory --value'
  $workingDir = $workingDirResult.Output.Trim()
  if ($workingDirResult.ExitCode -ne 0 -or -not $workingDir) {
    throw "dws-offload-run.ps1 -Target remote: could not read WorkingDirectory from orca-dws-serve.service (exit $($workingDirResult.ExitCode)): $($workingDirResult.Output)"
  }
  $actualHeadResult = Invoke-DwsSsh -RemoteBody "sudo git -c safe.directory=$workingDir -C $workingDir rev-parse HEAD"
  $actualHead = $actualHeadResult.Output.Trim()
  if ($actualHeadResult.ExitCode -ne 0 -or $actualHead -ne $deployed.sha) {
    throw "dws-offload-run.ps1 -Target remote: deployed.json sha ($($deployed.sha)) disagrees with the running unit's WorkingDirectory HEAD ($actualHead) -- refusing (re-run Publish-DwsServeBuild)"
  }
  Write-Output "DWS-P2-RUN remoteChecksVerified svcCheckout=$Checkout svcSha=$SvcSha workingDirectory=$workingDir"
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

# --- Remote target: bracket a `ps --forest` capture on GEX44 around the sweep, and pre/post the
# serve unit's own MainPID so a restart mid-run is INCONCLUSIVE, never silently accepted -------
# Why a hardcoded remote path/host, not a getter from dws-laptop-remote.psm1: $script:DwsSshHost
# and $script:DwsRemoteClone are module-PRIVATE ($script: scope), and the module exports no
# accessor for either. Duplicated here (values must match dws-laptop-remote.psm1's own constants).
$dwsRemoteSshHost = 'gex44'
$dwsRemoteClone = '/home/kobii/dws-0104-clone'
$remotePsProc = $null
$servePidBefore = $null
if ($Target -eq 'remote') {
  $statusBefore = Invoke-DwsSsh -RemoteBody "bash $dwsRemoteClone/config/scripts/dws-gex44-serve-provision.sh status"
  if ($statusBefore.ExitCode -ne 0) {
    New-Item -ItemType File -Path $stopFile -Force | Out-Null
    throw "remote status (before) failed (exit $($statusBefore.ExitCode)): $($statusBefore.Output)"
  }
  $statusBeforeLines = $statusBefore.Output -split "`n"
  $servePidBefore = ($statusBeforeLines | Select-Object -Index 1).Trim()
  Write-Output "DWS-P2-RUN remoteServeActive=$($statusBeforeLines[0].Trim()) remoteServeMainPidBefore=$servePidBefore"

  # Why Start-Process -RedirectStandardOutput, not Invoke-DwsSsh: Invoke-DwsSsh blocks until ssh
  # exits, but `ps-capture` is a long-running remote loop meant to run FOR THE DURATION of the
  # workload sweep below -- it must be started in the background. The remote command is still ONE
  # single argv element (host_rules' single-argument ssh-body rule), it is simply passed to
  # Start-Process's own array instead of through the (synchronous) Invoke-DwsSsh helper.
  $remotePsProc = Start-Process -FilePath 'ssh' -ArgumentList @(
    '-o', 'ConnectTimeout=20', '-o', 'BatchMode=yes', $dwsRemoteSshHost,
    "bash $dwsRemoteClone/config/scripts/dws-gex44-serve-provision.sh ps-capture $CaptureCount $CaptureIntervalSec"
  ) -RedirectStandardOutput $remotePsPath -PassThru -WindowStyle Hidden
  Write-Output "DWS-P2-RUN remotePsCapturePid=$($remotePsProc.Id) count=$CaptureCount intervalSec=$CaptureIntervalSec"

  if ('agent' -in $Legs) {
    # Existence-only credential check (never reads contents) -- host_rules: the agent-turn leg may
    # use ONLY a credential minted inside orca-svc's own HOME; if absent, record BLOCKED, never
    # fake/substitute it locally.
    # Why sudo -u, not ~: the ssh login is kobii, so ~ was kobii's home and his credential passed.
    # sudo -n fails instead of prompting, which reads as no credential (fail closed).
    $credCheck = Invoke-DwsSsh -RemoteBody 'sudo -n -u orca-svc test -s /home/orca-svc/.claude/.credentials.json && echo CLAUDE_CRED=1 || echo CLAUDE_CRED=0; sudo -n -u orca-svc test -s /home/orca-svc/.codex/auth.json && echo CODEX_CRED=1 || echo CODEX_CRED=0'
    Write-Output "DWS-P2-RUN agentCredentialCheck=$($credCheck.Output -replace "`n", ' ')"
    $agentCredKey = if ($AgentKind -eq 'codex') { 'CODEX_CRED=1' } else { 'CLAUDE_CRED=1' }
    if ($credCheck.ExitCode -ne 0 -or $credCheck.Output -notmatch [regex]::Escape($agentCredKey)) {
      Write-Output "DWS-P2-RUN agentLeg=BLOCKED reason=no_credential_in_orca-svc_home need=$agentCredKey (never copying kobii's/laptop's credential per host_rules)"
      $Legs = @($Legs | Where-Object { $_ -ne 'agent' })
      if ($Legs.Count -eq 0) {
        New-Item -ItemType File -Path $stopFile -Force | Out-Null
        if (-not $remotePsProc.HasExited) {
          Stop-Process -Id $remotePsProc.Id -Force -ErrorAction SilentlyContinue
        }
        throw "dws-offload-run.ps1: the agent leg is BLOCKED (no $agentCredKey in orca-svc's home) and no other leg remains"
      }
      Write-Output "DWS-P2-RUN legsAfterAgentBlock=$($Legs -join ',')"
    }
  }
}

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

$grepPattern = switch ($Target) {
  'local' { 'local workload' }
  'remote' { 'remote workload' }
  default { 'desktop artifact answers status' }
}

$env:ORCA_DWS_P2_TARGET = $Target
$env:ORCA_DWS_P2_CHECKOUT = $Checkout
$env:ORCA_DWS_P2_LEGS = ($Legs -join ',')
$env:ORCA_DWS_P2_RUN_DIR = $stateDir
if ($Target -eq 'remote') {
  $env:ORCA_DWS_P2_PAIRING_FILE = $PairingFile
  $env:ORCA_DWS_P2_ENV_NAME = $EnvName
  $env:ORCA_DWS_P2_SVC_SHA = $SvcSha
  if ($BaselineManifest) { $env:ORCA_DWS_P2_BASELINE_MANIFEST = $BaselineManifest }
  if ($AgentKind) { $env:ORCA_DWS_P2_AGENT_KIND = $AgentKind }
  if ($AgentBin) { $env:ORCA_DWS_P2_AGENT_BIN = $AgentBin }
}

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
  Remove-Item Env:\ORCA_DWS_P2_PAIRING_FILE -ErrorAction SilentlyContinue
  Remove-Item Env:\ORCA_DWS_P2_ENV_NAME -ErrorAction SilentlyContinue
  Remove-Item Env:\ORCA_DWS_P2_SVC_SHA -ErrorAction SilentlyContinue
  Remove-Item Env:\ORCA_DWS_P2_BASELINE_MANIFEST -ErrorAction SilentlyContinue
  Remove-Item Env:\ORCA_DWS_P2_AGENT_KIND -ErrorAction SilentlyContinue
  Remove-Item Env:\ORCA_DWS_P2_AGENT_BIN -ErrorAction SilentlyContinue
}

# --- Stop the sampler, record free memory AFTER --------------------------------------------------
New-Item -ItemType File -Path $stopFile -Force | Out-Null
$samplerExited = $samplerProc.WaitForExit(10000)
if (-not $samplerExited -and -not $samplerProc.HasExited) {
  Stop-Process -Id $samplerProc.Id -Force -ErrorAction SilentlyContinue
}

# --- Remote target: stop the ps-capture, verify the serve unit's MainPID did not change, and
# judge the manifest's legs against the capture via `remote-proof` -------------------------------
$remoteProofSummary = $null
if ($Target -eq 'remote') {
  if ($remotePsProc -and -not $remotePsProc.HasExited) {
    Stop-Process -Id $remotePsProc.Id -Force -ErrorAction SilentlyContinue
  }
  $statusAfter = Invoke-DwsSsh -RemoteBody "bash $dwsRemoteClone/config/scripts/dws-gex44-serve-provision.sh status"
  $servePidAfter = $null
  if ($statusAfter.ExitCode -eq 0) {
    $servePidAfter = (($statusAfter.Output -split "`n") | Select-Object -Index 1).Trim()
  }
  Write-Output "DWS-P2-RUN remoteServeMainPidAfter=$servePidAfter"
  $servePidStable = ($servePidBefore -and $servePidAfter -and $servePidBefore -eq $servePidAfter)
  if (-not $servePidStable) {
    Write-Output "DWS-P2-RUN remoteServeMainPidVerdict=INCONCLUSIVE reason=serve_restarted_mid_run before=$servePidBefore after=$servePidAfter"
  } else {
    Write-Output "DWS-P2-RUN remoteServeMainPidVerdict=STABLE pid=$servePidBefore"
  }

  $remoteProofExit = $null
  if ((Test-Path $manifestPath) -and (Test-Path $remotePsPath) -and $servePidBefore) {
    & node (Join-Path $repoRoot 'config/scripts/dws-offload-measurement.mjs') remote-proof `
      --capture $remotePsPath --manifest $manifestPath --serve-pid $servePidBefore --out $remoteProofPath
    $remoteProofExit = $LASTEXITCODE
    if (Test-Path $remoteProofPath) {
      $remoteProofSummary = Get-Content $remoteProofPath -Raw | ConvertFrom-Json
    }
  } else {
    Write-Output "DWS-P2-RUN warning=remote_proof_skipped manifestExists=$(Test-Path $manifestPath) captureExists=$(Test-Path $remotePsPath) servePidBefore=$servePidBefore"
  }
}

$freeAfterMb = Get-FreeMb

# --- Summarize -------------------------------------------------------------------------------
$summarizeExit = $null
if (Test-Path $manifestPath) {
  & node (Join-Path $repoRoot 'config/scripts/dws-offload-measurement.mjs') summarize `
    --samples $ndjsonPath --manifest $manifestPath --out $summaryPath
  $summarizeExit = $LASTEXITCODE
} else {
  Write-Output "DWS-P2-RUN warning=manifest_missing path=$manifestPath (spec did not reach the manifest-write step)"
}

# Why: automation reads $LASTEXITCODE, so a failed spec or an unjudgeable run must not exit 0.
$runExit = 0
$runExitReason = 'ok'
if ($pwExit -ne 0) {
  $runExit = $pwExit; $runExitReason = 'playwright_failed'
} elseif ($summarizeExit -ne 0 -or -not (Test-Path $summaryPath)) {
  $runExit = 3; $runExitReason = "summary_unjudgeable exit=$summarizeExit"
} elseif ($Target -eq 'remote' -and -not $servePidStable) {
  $runExit = 4; $runExitReason = 'serve_restarted_mid_run'
} elseif ($Target -eq 'remote' -and ($remoteProofExit -ne 0 -or -not $remoteProofSummary)) {
  $runExit = 5; $runExitReason = "remote_proof_not_pass exit=$remoteProofExit"
}

Write-Output "RUN=$RunId TARGET=$Target PLAYWRIGHT_EXIT=$pwExit FREE_BEFORE_MB=$freeBeforeMb FREE_AFTER_MB=$freeAfterMb SUMMARY=$summaryPath RUN_EXIT=$runExit REASON=$runExitReason"
exit $runExit
