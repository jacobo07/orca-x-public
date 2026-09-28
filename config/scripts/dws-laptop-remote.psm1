# DWS-P2 laptop-side tooling: publish a fenced build to GEX44, fetch the built artifact back,
# tunnel to the loopback-pinned serve over ssh -L, and drive a real CLI round-trip through it.
# PowerShell 5.1. git via the absolute path (not on the non-interactive PATH on this host).
# ssh bodies are always ONE single-quoted argument -- see STATE.md's PowerShell->ssh quoting traps.

$script:DwsGitExe = 'C:\Program Files\Git\cmd\git.exe'
$script:DwsSshHost = 'gex44'
$script:DwsSshTimeoutSec = 20
$script:DwsRemoteClone = '/home/kobii/dws-0104-clone'
$script:DwsRemoteOrcaX = '/home/kobii/orca-x'
$script:DwsBaseFenceSha = '865c80de25f4ebbd00ca83c71b0812113b24ac10'

function Get-DwsStateDir {
  $dir = Join-Path $env:LOCALAPPDATA 'orca-dws-p2'
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  return $dir
}

function Get-DwsWorktreeRoot {
  $top = & $script:DwsGitExe rev-parse --show-toplevel
  return ($top -replace '/', '\')
}

# One ssh call, remote body as a SINGLE single-quoted argument. Never pipe a here-string, never
# `cmd /c ... < file`. Embedded quoting inside $RemoteBody must use single quotes only.
function Invoke-DwsSsh {
  param(
    [Parameter(Mandatory)][string]$RemoteBody,
    [int]$TimeoutSec = $script:DwsSshTimeoutSec
  )
  $sshArgs = @('-o', "ConnectTimeout=$TimeoutSec", '-o', 'BatchMode=yes', $script:DwsSshHost, $RemoteBody)
  $out = & ssh @sshArgs 2>&1
  return [pscustomobject]@{
    ExitCode = $LASTEXITCODE
    Output   = ($out -join "`n")
  }
}

function Invoke-DwsScpTo {
  param([Parameter(Mandatory)][string]$LocalPath, [Parameter(Mandatory)][string]$RemotePath)
  & scp -o "ConnectTimeout=$script:DwsSshTimeoutSec" -o BatchMode=yes $LocalPath "$($script:DwsSshHost):$RemotePath" 2>&1 | Out-Null
  return $LASTEXITCODE
}

function Invoke-DwsScpFrom {
  param([Parameter(Mandatory)][string]$RemotePath, [Parameter(Mandatory)][string]$LocalPath)
  & scp -o "ConnectTimeout=$script:DwsSshTimeoutSec" -o BatchMode=yes "$($script:DwsSshHost):$RemotePath" $LocalPath 2>&1 | Out-Null
  return $LASTEXITCODE
}

<#
.SYNOPSIS
Publishes an incremental bundle of the current worktree HEAD to GEX44, fences a build clone to
<Sha>, builds it, and installs it under the orca-svc service (CTX-SVC-1/2/3).
#>
function Publish-DwsServeBuild {
  param(
    [Parameter(Mandatory)][string]$Sha,
    # Why a switch, not a default-on flag: the sandbox contingency (T-02-05) is a recorded,
    # deliberate exception -- never the default posture. Plan's own contingency: one retry with
    # this set is acceptable; a second identical failure is a pivot point, never a third retry.
    [switch]$NoSandbox
  )

  $state = Get-DwsStateDir
  $short = $Sha.Substring(0, 7)
  $worktree = Get-DwsWorktreeRoot

  # Witnesses (T-02-08): orca-x HEAD and two files under kobii's real agent homes must be
  # byte-for-byte unchanged after this whole publish, or the publish throws.
  $before = Invoke-DwsSsh -RemoteBody 'git -C /home/kobii/orca-x rev-parse HEAD; stat -c %Y /home/kobii/.claude/settings.json 2>/dev/null || echo none; stat -c %Y /home/kobii/.codex/config.toml 2>/dev/null || echo none'
  if ($before.ExitCode -ne 0) { throw "Publish-DwsServeBuild: pre-probe failed: $($before.Output)" }
  $beforeLines = $before.Output -split "`n"
  $orcaXHeadBefore = $beforeLines[0].Trim()
  $claudeMtimeBefore = $beforeLines[1].Trim()
  $codexMtimeBefore = $beforeLines[2].Trim()
  Write-Output "ORCA_X_HEAD_BEFORE=$orcaXHeadBefore"

  # Why HEAD, not the raw $Sha: git bundle create (2.52) refuses "Refusing to create empty
  # bundle" for a bare commit hash that is not the tip of a named ref, even when rev-list over
  # the identical hash returns real commits -- a bundle records ref NAMES, and a raw SHA has
  # none. This function is always called immediately after committing $Sha, so HEAD == $Sha is
  # a real invariant here (single sequential writer), verified below rather than assumed.
  $localHead = (& $script:DwsGitExe rev-parse HEAD).Trim()
  if ($localHead -ne $Sha) {
    throw "Publish-DwsServeBuild: local HEAD ($localHead) does not match requested Sha ($Sha) -- bundle would not cover the requested commit"
  }
  $bundlePath = Join-Path $state "dws-p2-$short.bundle"
  $baseRef = $script:DwsBaseFenceSha
  $mergeBaseCheck = & $script:DwsGitExe cat-file -e "$baseRef^{commit}" 2>&1
  if ($LASTEXITCODE -ne 0) {
    $baseRef = (& $script:DwsGitExe merge-base HEAD $script:DwsBaseFenceSha).Trim()
  }
  & $script:DwsGitExe bundle create $bundlePath HEAD "^$baseRef" 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Publish-DwsServeBuild: git bundle create failed" }
  Write-Output "BUNDLE_LOCAL=$bundlePath BUNDLE_BYTES=$((Get-Item $bundlePath).Length)"

  # Bootstrap: scp the CURRENT local copy of the provisioning script (not yet in the remote
  # clone at the old fence) so fetch-bundle can run once, checking out the new SHA -- which then
  # overwrites the clone's own copy of this same script for every subsequent step.
  $localScript = Join-Path $worktree 'config\scripts\dws-gex44-serve-provision.sh'
  $bootstrapRemote = "/home/kobii/dws-p2-bootstrap-$short.sh"
  if ((Invoke-DwsScpTo -LocalPath $localScript -RemotePath $bootstrapRemote) -ne 0) {
    throw "Publish-DwsServeBuild: scp of bootstrap script failed"
  }
  $remoteBundlePath = "/home/kobii/dws-p2-$short.bundle"
  if ((Invoke-DwsScpTo -LocalPath $bundlePath -RemotePath $remoteBundlePath) -ne 0) {
    throw "Publish-DwsServeBuild: scp of bundle failed"
  }

  $fetch = Invoke-DwsSsh -RemoteBody "bash $bootstrapRemote fetch-bundle $remoteBundlePath $Sha $short" -TimeoutSec 60
  Write-Output $fetch.Output
  if ($fetch.ExitCode -ne 0 -or $fetch.Output -notmatch "FENCE_OK $Sha") {
    throw "Publish-DwsServeBuild: fetch-bundle failed (exit $($fetch.ExitCode)): $($fetch.Output)"
  }

  $build = Invoke-DwsSsh -RemoteBody "bash $script:DwsRemoteClone/config/scripts/dws-gex44-serve-provision.sh build $Sha" -TimeoutSec 600
  Write-Output $build.Output
  if ($build.ExitCode -ne 0 -or $build.Output -notmatch "ARTIFACT_SHA256=([0-9a-f]{64})") {
    throw "Publish-DwsServeBuild: build failed (exit $($build.ExitCode)): $($build.Output)"
  }
  $artifactSha256 = $Matches[1]
  if ($build.Output -notmatch 'ARTIFACT=(\S+)') { throw 'Publish-DwsServeBuild: no ARTIFACT= path in build output' }
  $artifactRemotePath = $Matches[1]

  $installPrefix = if ($NoSandbox) { 'sudo env DWS_SERVE_NO_SANDBOX=1' } else { 'sudo' }
  $install = Invoke-DwsSsh -RemoteBody "$installPrefix bash $script:DwsRemoteClone/config/scripts/dws-gex44-serve-provision.sh install $Sha $artifactRemotePath $artifactSha256" -TimeoutSec 180
  Write-Output $install.Output
  if ($install.ExitCode -ne 0 -or $install.Output -notmatch 'READY boundEndpoint=(\S+)') {
    throw "Publish-DwsServeBuild: install failed (exit $($install.ExitCode)): $($install.Output)"
  }
  $boundEndpoint = $Matches[1]
  if ($install.Output -notmatch 'SVC_FENCE_OK (\S+)') { throw 'Publish-DwsServeBuild: no SVC_FENCE_OK in install output' }

  $after = Invoke-DwsSsh -RemoteBody 'git -C /home/kobii/orca-x rev-parse HEAD; stat -c %Y /home/kobii/.claude/settings.json 2>/dev/null || echo none; stat -c %Y /home/kobii/.codex/config.toml 2>/dev/null || echo none'
  if ($after.ExitCode -ne 0) { throw "Publish-DwsServeBuild: post-probe failed: $($after.Output)" }
  $afterLines = $after.Output -split "`n"
  $orcaXHeadAfter = $afterLines[0].Trim()
  $claudeMtimeAfter = $afterLines[1].Trim()
  $codexMtimeAfter = $afterLines[2].Trim()
  Write-Output "ORCA_X_HEAD_AFTER=$orcaXHeadAfter"

  if ($orcaXHeadAfter -ne $orcaXHeadBefore) {
    throw "Publish-DwsServeBuild: /home/kobii/orca-x HEAD moved ($orcaXHeadBefore -> $orcaXHeadAfter)"
  }
  if ($claudeMtimeAfter -ne $claudeMtimeBefore -or $codexMtimeAfter -ne $codexMtimeBefore) {
    throw "Publish-DwsServeBuild: witness mtime changed (claude $claudeMtimeBefore->$claudeMtimeAfter, codex $codexMtimeBefore->$codexMtimeAfter)"
  }

  $svcCheckout = "/home/orca-svc/dws-p2/$short"
  $deployed = [pscustomobject]@{
    sha            = $Sha
    short          = $short
    svcCheckout    = $svcCheckout
    artifactSha256 = $artifactSha256
    boundEndpoint  = $boundEndpoint
    utc            = (Get-Date).ToUniversalTime().ToString('o')
  }
  $deployed | ConvertTo-Json | Set-Content -Encoding ascii (Join-Path $state 'deployed.json')
  Write-Output "PUBLISH_OK sha=$Sha artifactSha256=$artifactSha256 boundEndpoint=$boundEndpoint"
  return $deployed
}

<#
.SYNOPSIS
Fetches the built artifact tarball to the laptop, verifies its sha256, and extracts it into the
worktree's out/ directory (moving any existing out/ aside first, never deleting it).
#>
function Get-DwsArtifact {
  param([Parameter(Mandatory)][string]$Sha, [Parameter(Mandatory)][string]$ExpectedSha256)

  $state = Get-DwsStateDir
  $worktree = Get-DwsWorktreeRoot
  $short = $Sha.Substring(0, 7)
  $remoteArtifact = "/home/kobii/dws-runs/p2-$short-out.tar.gz"
  $localArtifact = Join-Path $state "p2-$short-out.tar.gz"

  if ((Invoke-DwsScpFrom -RemotePath $remoteArtifact -LocalPath $localArtifact) -ne 0) {
    throw "Get-DwsArtifact: scp from $remoteArtifact failed"
  }
  $hash = (Get-FileHash -Algorithm SHA256 -Path $localArtifact).Hash.ToLowerInvariant()
  Write-Output "LAPTOP_ARTIFACT_SHA256=$hash"
  if ($hash -ne $ExpectedSha256.ToLowerInvariant()) {
    throw "Get-DwsArtifact: sha256 mismatch (expected $ExpectedSha256, got $hash)"
  }

  $outDir = Join-Path $worktree 'out'
  if (Test-Path $outDir) {
    $utcTag = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
    $movedAside = Join-Path $state "out.pre-$utcTag"
    Move-Item -Path $outDir -Destination $movedAside -Force
    Write-Output "PREVIOUS_OUT_MOVED_TO=$movedAside"
  }
  New-Item -ItemType Directory -Path $outDir -Force | Out-Null
  & tar.exe -xzf $localArtifact -C $outDir
  if ($LASTEXITCODE -ne 0) { throw 'Get-DwsArtifact: tar extraction failed' }
  Write-Output "ARTIFACT_EXTRACTED=$outDir"
}

<#
.SYNOPSIS
Fetches the latest serve-ready.jsonl line from GEX44 into local state and returns
boundEndpoint/port/pairingSha12 -- never the pairing URL itself.
#>
function Get-DwsServeReady {
  $state = Get-DwsStateDir
  $readyPath = Join-Path $state 'serve-ready.json'
  $result = Invoke-DwsSsh -RemoteBody "sudo bash $script:DwsRemoteClone/config/scripts/dws-gex44-serve-provision.sh ready-json"
  if ($result.ExitCode -ne 0 -or [string]::IsNullOrWhiteSpace($result.Output)) {
    throw "Get-DwsServeReady: ready-json failed (exit $($result.ExitCode))"
  }
  $result.Output | Set-Content -Encoding ascii $readyPath
  $json = $result.Output | ConvertFrom-Json
  $boundEndpoint = $json.boundEndpoint
  $port = ([uri]$boundEndpoint).Port
  $pairingSha12 = $null
  if ($json.pairing -and $json.pairing.url) {
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json.pairing.url)
    $hashBytes = $sha256.ComputeHash($bytes)
    $pairingSha12 = -join ($hashBytes[0..5] | ForEach-Object { $_.ToString('x2') })
  }
  return [pscustomobject]@{
    boundEndpoint = $boundEndpoint
    port          = $port
    pairingSha12  = $pairingSha12
  }
}

<#
.SYNOPSIS
Starts an ssh -L forward from 127.0.0.1:<Port> on the laptop to 127.0.0.1:<Port> on GEX44, and
requires an application-level 200 before returning (a TCP connect alone proves nothing).
#>
function Start-DwsTunnel {
  param([Parameter(Mandatory)][int]$Port)

  $state = Get-DwsStateDir
  $pidPath = Join-Path $state 'tunnel.pid'

  $existingListener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  if ($existingListener) {
    if (Test-Path $pidPath) {
      $existingPid = Get-Content $pidPath
      if ($existingListener.OwningProcess -contains [int]$existingPid) {
        Write-Output "TUNNEL_ALREADY_RUNNING pid=$existingPid port=$Port"
        return
      }
    }
    throw "Start-DwsTunnel: 127.0.0.1:$Port is already held by another process (not our recorded tunnel)"
  }

  $sshArgs = @(
    '-N', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=15', '-o', 'BatchMode=yes',
    '-L', "127.0.0.1:${Port}:127.0.0.1:${Port}", $script:DwsSshHost
  )
  $proc = Start-Process -FilePath ssh -ArgumentList $sshArgs -PassThru -WindowStyle Hidden
  $proc.Id | Set-Content -Encoding ascii $pidPath
  Write-Output "TUNNEL_STARTED pid=$($proc.Id) port=$Port"

  $deadline = (Get-Date).AddSeconds(15)
  $ready = $false
  while ((Get-Date) -lt $deadline) {
    try {
      $resp = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/web-index.html" -UseBasicParsing -TimeoutSec 3
      if ($resp.StatusCode -eq 200) { $ready = $true; break }
    } catch {
      Start-Sleep -Milliseconds 500
    }
  }
  if (-not $ready) {
    throw "Start-DwsTunnel: tunnel did not answer 200 on /web-index.html within 15s"
  }
  Write-Output "TUNNEL_READY port=$Port"
}

function Stop-DwsTunnel {
  $state = Get-DwsStateDir
  $pidPath = Join-Path $state 'tunnel.pid'
  if (-not (Test-Path $pidPath)) { Write-Output 'TUNNEL_NOT_RUNNING'; return }
  $tunnelPid = Get-Content $pidPath
  Stop-Process -Id $tunnelPid -Force -ErrorAction SilentlyContinue
  Remove-Item $pidPath -Force -ErrorAction SilentlyContinue
  Write-Output "TUNNEL_STOPPED pid=$tunnelPid"
}

<#
.SYNOPSIS
Runs the Orca CLI against the paired remote environment. The pairing code is loaded into the
child's environment only -- never argv, never printed.
#>
function Invoke-DwsCli {
  param([Parameter(Mandatory)][string[]]$Args)

  $state = Get-DwsStateDir
  $worktree = Get-DwsWorktreeRoot
  $readyPath = Join-Path $state 'serve-ready.json'
  if (-not (Test-Path $readyPath)) { throw 'Invoke-DwsCli: no serve-ready.json; call Get-DwsServeReady first' }
  $json = Get-Content $readyPath -Raw | ConvertFrom-Json
  $pairingCode = $null
  # Why .url, not .code: the ready-json pairing object has no separate "code" field -- the CLI's
  # ORCA_PAIRING_CODE / --pairing-code both take the full `orca://pair?code=...` URL (help.ts).
  if ($json.pairing -and $json.pairing.available) { $pairingCode = $json.pairing.url }

  foreach ($a in $Args) {
    if ($a.Contains('"')) { throw "Invoke-DwsCli: argument contains a double quote, unsupported: $a" }
  }

  $cliEntry = Join-Path $worktree 'out\cli\index.js'
  $profileDir = Join-Path $state 'cli-profile'
  New-Item -ItemType Directory -Path $profileDir -Force | Out-Null

  $env:ORCA_USER_DATA_PATH = $profileDir
  if ($pairingCode) { $env:ORCA_PAIRING_CODE = $pairingCode }
  try {
    $fullArgs = @($cliEntry) + $Args + @('--json')
    $output = & node @fullArgs 2>&1
    return [pscustomobject]@{ ExitCode = $LASTEXITCODE; Output = ($output -join "`n") }
  } finally {
    Remove-Item Env:\ORCA_PAIRING_CODE -ErrorAction SilentlyContinue
  }
}

<#
.SYNOPSIS
End-to-end tracer: adds the service checkout as a repo, opens a terminal in it, and requires the
remote shell's own output (nonce, orca-svc, kobicraft-gex44) to prove a real PTY ran on GEX44.
#>
function Invoke-DwsRemoteRoundTrip {
  $state = Get-DwsStateDir
  if (-not (Test-Path (Join-Path $state 'deployed.json'))) {
    Write-Output 'ROUNDTRIP=FAIL reason=no_deployed_json_run_Publish-DwsServeBuild_first'
    return
  }
  $deployed = Get-Content (Join-Path $state 'deployed.json') -Raw | ConvertFrom-Json
  $nonce = [guid]::NewGuid().ToString('N').Substring(0, 12)

  try {
    Get-DwsServeReady | Out-Null
  } catch {
    Write-Output "ROUNDTRIP=FAIL reason=serve_ready_failed:$($_.Exception.Message)"
    return
  }

  $addResult = Invoke-DwsCli -Args @('repo', 'add', '--path', $deployed.svcCheckout)
  if ($addResult.ExitCode -ne 0) {
    Write-Output "ROUNDTRIP=FAIL reason=repo_add_failed:$($addResult.Output)"
    return
  }

  $command = "echo DWS-P2-TRACER-$nonce; id -un; hostname"
  $createResult = Invoke-DwsCli -Args @(
    'terminal', 'create', '--worktree', "path:$($deployed.svcCheckout)", '--title', 'dws-p2-tracer', '--command', $command
  )
  if ($createResult.ExitCode -ne 0) {
    Write-Output "ROUNDTRIP=FAIL reason=terminal_create_failed:$($createResult.Output)"
    return
  }
  $handle = $null
  try {
    $created = $createResult.Output | ConvertFrom-Json
    # Why .terminal.handle: `terminal create --json` nests the handle under a `terminal` object
    # (index-terminal-commands.test.ts), it is not a bare string field.
    $handle = $created.terminal.handle
    if (-not $handle) { $handle = $created.handle }
    if (-not $handle) { $handle = $created.id }
  } catch {
    Write-Output "ROUNDTRIP=FAIL reason=terminal_create_unparseable:$($createResult.Output)"
    return
  }
  if (-not $handle) {
    Write-Output "ROUNDTRIP=FAIL reason=terminal_create_no_handle:$($createResult.Output)"
    return
  }

  $deadline = (Get-Date).AddSeconds(30)
  $sawAll = $false
  $lastRead = ''
  while ((Get-Date) -lt $deadline) {
    $readResult = Invoke-DwsCli -Args @('terminal', 'read', '--terminal', $handle)
    $lastRead = $readResult.Output
    if ($lastRead -match [regex]::Escape("DWS-P2-TRACER-$nonce") -and $lastRead -match 'orca-svc' -and $lastRead -match 'kobicraft-gex44') {
      $sawAll = $true
      break
    }
    Start-Sleep -Milliseconds 750
  }

  $statusCapture = Invoke-DwsSsh -RemoteBody "bash $script:DwsRemoteClone/config/scripts/dws-gex44-serve-provision.sh status"
  Write-Output "STATUS_CAPTURE:`n$($statusCapture.Output)"

  if (-not $sawAll) {
    Write-Output "ROUNDTRIP=FAIL reason=marker_not_observed nonce=$nonce lastRead=$lastRead"
    return
  }
  Write-Output "ROUNDTRIP=PASS nonce=$nonce serveSha=$($deployed.sha)"
}

Export-ModuleMember -Function `
  Publish-DwsServeBuild, Get-DwsArtifact, Get-DwsServeReady, Start-DwsTunnel, Stop-DwsTunnel, `
  Invoke-DwsCli, Invoke-DwsRemoteRoundTrip, Get-DwsStateDir, Get-DwsWorktreeRoot, Invoke-DwsSsh
