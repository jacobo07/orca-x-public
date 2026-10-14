# DWS-P5 SC3 ladder: redeploy orca-dws-serve at HEAD through the phase-2 lane (named debt ND-1: the
# bundle+ssh evidence lane; ND-2: the laptop ssh -L forward), read GEX44 memory/disk/VRAM/resident model
# through the product and through an independent ssh control, and write the evidence bundle.
# PowerShell 5.1. Rungs: fan-out (laptop-local runtime) > gex44-local-caller (built CLI run on GEX44) > none (BLOCKED).
# The pairing URL stays in memory (Get-DwsServeReady); nothing here writes it anywhere.
# -FanOut: no deploy; an isolated laptop Orca pairs through the tunnel and answers fleet manifest (step 5).
param([switch]$Resume, [switch]$NoSandbox, [switch]$FanOut)

# Why Continue: the lane wraps ssh with 2>&1, and Stop turns git's stderr progress lines into terminating errors.
$ErrorActionPreference = 'Continue'
$git = 'C:\Program Files\Git\cmd\git.exe'
Import-Module (Join-Path $PSScriptRoot 'dws-laptop-remote.psm1') -Force

$repo = Get-DwsWorktreeRoot
$p2State = Get-DwsStateDir
$state = Join-Path $env:LOCALAPPDATA 'orca-dws-p5'
New-Item -ItemType Directory -Path $state -Force | Out-Null
$stepsLog = Join-Path $state 'steps.log'
$controlRemote = '/home/kobii/dws-runs/dws-node-manifest-ssh-control.sh'
$remoteOut = '/home/orca-svc/.orca-dws'

function Write-Step {
  param([int]$N, [string]$Name, [string]$Status, [string]$Reason = '')
  $line = "STEP $N $Name $Status $Reason".TrimEnd()
  Write-Output $line
  Add-Content -Path $stepsLog -Value $line -Encoding ascii
}

function Test-ControlBegin {
  param([string]$Text)
  $first = ($Text -split "`n" | Where-Object { $_.Trim() -ne '' } | Select-Object -First 1)
  return ($null -ne $first -and $first.Trim() -eq 'CONTROL_BEGIN')
}

$rec = [ordered]@{
  headSha = $null; utcStart = (Get-Date).ToUniversalTime().ToString('o'); utcEnd = $null
  rung = 'none'; rungReached = 'none'; blockedReason = $null; deployed = $null
  probePort = $null; runtimeIdMatchesServe = $null; laptopFreeMb = $null
  controlBefore = $null; controlAfter = $null; productManifest = $null; serveRuntimeId = $null
  fanOut = $null; teardown = $null; mainPidBefore = $null; mainPidAfter = $null
}
$tunnelPort = $null
$block = $null

function Set-Block {
  param([string]$Reason)
  $script:block = $Reason
}

try {
  do {
    # 1 PREFLIGHT
    $dirty = @(& $git status --porcelain -- src config docs | Where-Object { $_ -and $_ -notmatch 'dws-node-manifest-(run\.ps1|evidence-write\.mjs)|docs/dws/phase-5-node-manifest\.(json|md)|docs/dws/node-manifest-handoff\.md' })
    if ($dirty.Count -gt 0) { Write-Step 1 PREFLIGHT FAIL "tracked tree not clean: $($dirty -join ' | ')"; Set-Block 'preflight-dirty-tree'; break }
    $head = (& $git rev-parse HEAD).Trim()
    $rec.headSha = $head
    $rec.laptopFreeMb = [math]::Round((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1024, 1)
    $probe = Invoke-DwsSsh -RemoteBody 'echo GEX44_OK'
    if ($probe.ExitCode -ne 0 -or $probe.Output -notmatch 'GEX44_OK') {
      Write-Step 1 PREFLIGHT FAIL "ssh unreachable exit=$($probe.ExitCode)"; Set-Block 'ssh-unreachable'; break
    }
    $rec.mainPidBefore = (Invoke-DwsSsh -RemoteBody 'systemctl show orca-dws-serve.service -p MainPID --value').Output.Trim()
    $rec.rungReached = 'preflight'
    Write-Step 1 PREFLIGHT OK "head=$head laptopFreeMb=$($rec.laptopFreeMb) mainPidBefore=$($rec.mainPidBefore)"

    # 2 DEPLOY
    $deployedPath = Join-Path $p2State 'deployed.json'
    if ($FanOut) {
      if (-not (Test-Path $deployedPath)) { Write-Step 2 DEPLOY FAIL 'fan-out needs deployed.json'; Set-Block 'fanout-no-deployed'; break }
      $deployed = Get-Content $deployedPath -Raw | ConvertFrom-Json
      # Why: the laptop runtime must run the same product as the serve; only harness files may differ.
      $srcDiff = @(& $git diff --name-only $deployed.sha HEAD -- src | Where-Object { $_ })
      if ($srcDiff.Count -gt 0) { Write-Step 2 DEPLOY FAIL "fan-out: laptop src differs from deployed: $($srcDiff -join ' ')"; Set-Block 'fanout-src-differs'; break }
      Write-Step 2 DEPLOY SKIP "fan-out: laptop src equals deployed $($deployed.sha)"
    } elseif ($Resume -and (Test-Path $deployedPath) -and ((Get-Content $deployedPath -Raw | ConvertFrom-Json).sha -eq $head)) {
      $deployed = Get-Content $deployedPath -Raw | ConvertFrom-Json
      Write-Step 2 DEPLOY SKIP "resume: deployed.json already at $head"
    } else {
      try {
        $pub = @(Publish-DwsServeBuild -Sha $head -NoSandbox:$NoSandbox)
      } catch {
        $full = ($_.Exception.Message -replace 'orca:[/]{2}pair\S*', '<redacted>' -replace '[?]code[=]\S*', '<redacted>')
        Set-Content -Path (Join-Path $state 'deploy-error.txt') -Value $full -Encoding ascii
        $msg = ($full -replace '\s+', ' ')
        if ($msg.Length -gt 400) { $msg = '...' + $msg.Substring($msg.Length - 400) }
        Write-Step 2 DEPLOY FAIL $msg; Set-Block "deploy-failed: $msg"; break
      }
      $pub | Where-Object { $_ -is [string] } | Set-Content -Encoding ascii (Join-Path $state 'publish.log')
      $deployed = $pub | Where-Object { $_ -isnot [string] } | Select-Object -Last 1
    }
    $workingDir = (Invoke-DwsSsh -RemoteBody 'systemctl show orca-dws-serve.service -p WorkingDirectory --value').Output.Trim()
    $actualHead = (Invoke-DwsSsh -RemoteBody "sudo git -c safe.directory=$workingDir -C $workingDir rev-parse HEAD").Output.Trim()
    $active = (Invoke-DwsSsh -RemoteBody 'systemctl is-active orca-dws-serve.service').Output.Trim()
    if (-not $workingDir -or $actualHead -ne $deployed.sha -or $active -ne 'active') {
      Write-Step 2 DEPLOY FAIL "staleness guard workingDir=$workingDir remoteHead=$actualHead deployedSha=$($deployed.sha) active=$active"
      Set-Block 'deploy-staleness-guard'; break
    }
    $rec.rungReached = 'deploy'
    Write-Step 2 DEPLOY OK "sha=$($deployed.sha) remoteHead=$actualHead active=$active"

    # 3 ARTIFACT BOTH ENDS
    $short = $deployed.short
    $remoteArtifact = "/home/kobii/dws-runs/p2-$short-out.tar.gz"
    try {
      Get-DwsArtifact -Sha $deployed.sha -ExpectedSha256 $deployed.artifactSha256 | Out-Null
    } catch {
      $msg = ($_.Exception.Message -replace '\s+', ' ')
      Write-Step 3 ARTIFACT FAIL "laptop end: $msg"; Set-Block "artifact-laptop: $msg"; break
    }
    $laptopSha = (Get-FileHash -Algorithm SHA256 -Path (Join-Path $p2State "p2-$short-out.tar.gz")).Hash.ToLowerInvariant()
    $remote = Invoke-DwsSsh -RemoteBody "sha256sum $remoteArtifact"
    $remoteSha = if ($remote.Output -match '^([0-9a-f]{64})') { $Matches[1] } else { $null }
    if ($remote.ExitCode -ne 0 -or -not $remoteSha) {
      Write-Step 3 ARTIFACT FAIL 'remote sha256sum unreadable'; Set-Block 'artifact-remote-unreadable'; break
    }
    if ($remoteSha -ne $laptopSha) {
      Write-Step 3 ARTIFACT FAIL "sha256 differs laptop=$laptopSha gex44=$remoteSha"; Set-Block 'artifact-sha-mismatch'; break
    }
    $rec.deployed = [ordered]@{
      sha = $deployed.sha; svcCheckout = $deployed.svcCheckout; boundEndpoint = $deployed.boundEndpoint
      artifactSha256Laptop = $laptopSha; artifactSha256Gex44 = $remoteSha; deployedUtc = $deployed.utc
    }
    $rec.rungReached = 'artifact'
    Write-Step 3 ARTIFACT OK "laptop=$laptopSha gex44=$remoteSha"

    # 4 CONTROL BEFORE
    # Why LF-normalized: an autocrlf checkout ships CRLF, every remote line gets a \r and the control goes blind.
    $localControl = Join-Path $state 'dws-node-manifest-ssh-control.lf.sh'
    $controlText = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'dws-node-manifest-ssh-control.sh')) -replace "`r`n", "`n"
    [IO.File]::WriteAllText($localControl, $controlText, (New-Object System.Text.UTF8Encoding $false))
    if ((Invoke-DwsScpTo -LocalPath $localControl -RemotePath $controlRemote) -ne 0) {
      Write-Step 4 CONTROL_BEFORE FAIL 'scp of the control script failed'; Set-Block 'control-scp-failed'; break
    }
    $noPort = Invoke-DwsSsh -RemoteBody "sh $controlRemote" -TimeoutSec 40
    if (-not (Test-ControlBegin $noPort.Output)) {
      Write-Step 4 CONTROL_BEFORE FAIL 'first control run: no CONTROL_BEGIN (harness failure, not a measurement)'; Set-Block 'control-harness-failure'; break
    }
    $serveHostPort = ([uri]$deployed.boundEndpoint).Port
    $ssSection = ($noPort.Output -split 'CONTROL_SS', 2)[1]
    $candidates = @()
    if ($ssSection) {
      foreach ($m in [regex]::Matches($ssSection, '(?m)(?:127\.0\.0\.1|0\.0\.0\.0|\*):(\d+)\s')) {
        $p = [int]$m.Groups[1].Value
        if ($p -ne 22 -and $p -ne $serveHostPort -and $candidates -notcontains $p) { $candidates += $p }
      }
    }
    $probePort = $null
    foreach ($p in ($candidates | Select-Object -First 12)) {
      $code = (Invoke-DwsSsh -RemoteBody "curl -s -m 3 -o /dev/null -w '%{http_code}' http://127.0.0.1:$($p)/v1/models").Output.Trim()
      if ($code -eq '200') { $probePort = $p; break }
    }
    $rec.probePort = $probePort
    $withPort = if ($probePort) { "sh $controlRemote $probePort" } else { "sh $controlRemote" }
    $before = Invoke-DwsSsh -RemoteBody $withPort -TimeoutSec 40
    if (-not (Test-ControlBegin $before.Output)) {
      Write-Step 4 CONTROL_BEFORE FAIL 'second control run: no CONTROL_BEGIN'; Set-Block 'control-harness-failure'; break
    }
    $rec.controlBefore = Join-Path $state 'control-before.txt'
    Set-Content -Path $rec.controlBefore -Value $before.Output -Encoding ascii
    $rec.rungReached = 'control-before'
    Write-Step 4 CONTROL_BEFORE OK "probePort=$probePort candidates=$($candidates -join ',')"

    $ready = Get-DwsServeReady
    $tunnelPort = $ready.port
    $readyLine = (Invoke-DwsSsh -RemoteBody "sudo bash /home/kobii/dws-0104-clone/config/scripts/dws-gex44-serve-provision.sh ready-json").Output
    $readyObj = $null
    try { $readyObj = $readyLine | ConvertFrom-Json } catch { $readyObj = $null }
    $serveRuntimeId = $null
    if ($readyObj) {
      foreach ($k in 'runtimeId', 'runtime_id') { if ($readyObj.$k) { $serveRuntimeId = [string]$readyObj.$k } }
    }
    $rec.serveRuntimeId = $serveRuntimeId
    Start-DwsTunnel -Port $tunnelPort | Out-Null

    # 5 PRODUCT READING, fan-out
    if ($FanOut) {
      if (-not $serveRuntimeId) { Write-Step 5 FANOUT FAIL 'serve runtime id unreadable'; Set-Block 'fanout-no-runtime-id'; break }
      & node (Join-Path $repo 'config/scripts/ensure-native-runtime.mjs') --runtime=electron
      if ($LASTEXITCODE -ne 0) { Write-Step 5 FANOUT FAIL "ensure-native-runtime exit=$LASTEXITCODE"; Set-Block 'fanout-native-runtime'; break }
      $fanOutPath = Join-Path $state 'product-manifest-fanout.json'
      Remove-Item $fanOutPath -ErrorAction SilentlyContinue
      $fanOutEnv = 'ORCA_DWS_P5_FANOUT', 'ORCA_DWS_P5_PAIRING_URL', 'ORCA_DWS_P5_OUT', 'ORCA_DWS_P5_SERVE_RUNTIME_ID', 'ORCA_DWS_P5_PROBE_PORT'
      $env:ORCA_DWS_P5_FANOUT = '1'
      # Why module scope: the credential lives only in the module's memory (see Get-DwsServeReady).
      $env:ORCA_DWS_P5_PAIRING_URL = & (Get-Module dws-laptop-remote) { $script:DwsLastPairingUrl }
      $env:ORCA_DWS_P5_OUT = $fanOutPath
      $env:ORCA_DWS_P5_SERVE_RUNTIME_ID = $serveRuntimeId
      if ($probePort) { $env:ORCA_DWS_P5_PROBE_PORT = [string]$probePort }
      $pwExit = 1
      Push-Location $repo
      try {
        $pwOut = & node (Join-Path $repo 'node_modules/@playwright/test/cli.js') test --config tests/playwright.config.ts --project electron-headless --workers=1 tests/e2e/dws-node-manifest-fanout.spec.ts 2>&1
        $pwExit = $LASTEXITCODE
      } finally {
        Pop-Location
        foreach ($name in $fanOutEnv) { Remove-Item "Env:\$name" -ErrorAction SilentlyContinue }
      }
      $pwText = (($pwOut | ForEach-Object { "$_" }) -join "`n") -replace 'orca:[/]{2}pair\S*', '<redacted>' -replace '[?]code[=]\S*', '<redacted>'
      Set-Content -Path (Join-Path $state 'fanout-playwright.log') -Value $pwText -Encoding utf8
      # Why the file and not only the exit: a skipped test also exits 0.
      if ($pwExit -ne 0 -or -not (Test-Path $fanOutPath)) {
        Write-Step 5 FANOUT FAIL "playwright exit=$pwExit manifestWritten=$(Test-Path $fanOutPath)"; Set-Block "fanout-spec-failed: exit=$pwExit"; break
      }
      $rec.productManifest = $fanOutPath
      $rec.rung = 'fan-out'
      $rec.rungReached = 'product-read'
      $rec.fanOut = 'an isolated laptop Orca paired over the ssh -L tunnel answered fleet.nodeManifests through callEnvironment'
      Write-Step 5 FANOUT OK "bytes=$((Get-Item $fanOutPath).Length)"
    } else {
      $orcaProcs = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match '^(?i)orca' }).Count
      $rec.fanOut = "not attempted (no -FanOut): orcaProcesses=$orcaProcs, laptopFreeMb=$($rec.laptopFreeMb)"
      Write-Step 5 FANOUT SKIP $rec.fanOut

      # 6 PRODUCT READING, gex44-local-caller
      $nonce = [guid]::NewGuid().ToString('N').Substring(0, 12)
      $svc = $deployed.svcCheckout
      $add = Invoke-DwsCli -Args @('repo', 'add', '--path', $svc)
      $portFlag = if ($probePort) { "--model-probe-ports $probePort " } else { '' }
      $cmd = "node $svc/out/cli/index.js fleet manifest $($portFlag)--json > $remoteOut/p5-$nonce.json 2> $remoteOut/p5-$nonce.err; echo done > $remoteOut/p5-$nonce.done"
      $create = Invoke-DwsCli -Args @('terminal', 'create', '--worktree', "path:$svc", '--title', 'dws-p5-manifest', '--command', $cmd)
      if ($create.ExitCode -ne 0) {
        Write-Step 6 GEX44_LOCAL_CALLER FAIL "terminal create exit=$($create.ExitCode) repoAddExit=$($add.ExitCode)"; Set-Block 'terminal-create-failed'; break
      }
      $done = $false
      $deadline = (Get-Date).AddSeconds(120)
      while ((Get-Date) -lt $deadline) {
        $t = Invoke-DwsSsh -RemoteBody "sudo test -s $remoteOut/p5-$nonce.done && echo P5_DONE"
        if ($t.Output -match 'P5_DONE') { $done = $true; break }
        Start-Sleep -Seconds 3
      }
      if (-not $done) {
        Write-Step 6 GEX44_LOCAL_CALLER FAIL 'manifest command did not finish within 120s'; Set-Block 'manifest-command-timeout'; break
      }
      $cat = Invoke-DwsSsh -RemoteBody "sudo cat $remoteOut/p5-$nonce.json" -TimeoutSec 40
      $manifestPath = Join-Path $state 'product-manifest.json'
      Set-Content -Path $manifestPath -Value $cat.Output -Encoding ascii
      $rec.productManifest = $manifestPath
      $rec.rung = 'gex44-local-caller'
      $rec.rungReached = 'product-read'
      Write-Step 6 GEX44_LOCAL_CALLER OK "nonce=$nonce serveRuntimeIdKnown=$([bool]$serveRuntimeId) bytes=$($cat.Output.Length)"
    }

    # 7 CONTROL AFTER
    $after = Invoke-DwsSsh -RemoteBody $withPort -TimeoutSec 40
    if (-not (Test-ControlBegin $after.Output)) {
      Write-Step 7 CONTROL_AFTER FAIL 'no CONTROL_BEGIN'
    } else {
      $rec.controlAfter = Join-Path $state 'control-after.txt'
      Set-Content -Path $rec.controlAfter -Value $after.Output -Encoding ascii
      Write-Step 7 CONTROL_AFTER OK ''
    }
  } while ($false)
} catch {
  $msg = ($_.Exception.Message -replace '\s+', ' ')
  if ($msg.Length -gt 300) { $msg = $msg.Substring(0, 300) }
  Write-Step 0 UNEXPECTED FAIL $msg
  Set-Block "unexpected: $msg"
} finally {
  # 8 TEARDOWN
  $tearNotes = @()
  try { Stop-DwsTunnel | ForEach-Object { $tearNotes += $_ } } catch { $tearNotes += "stop-tunnel-error: $($_.Exception.Message)" }
  Start-Sleep -Seconds 1
  $sshTunnels = @(Get-CimInstance Win32_Process -Filter "Name='ssh.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match '-L\s+"?127\.0\.0\.1:\d+:127\.0\.0\.1:\d+' }).Count
  $listener = if ($tunnelPort) { @(Get-NetTCPConnection -LocalPort $tunnelPort -State Listen -ErrorAction SilentlyContinue).Count } else { 0 }
  $svcActive = (Invoke-DwsSsh -RemoteBody 'systemctl is-active orca-dws-serve.service').Output.Trim()
  $rec.mainPidAfter = (Invoke-DwsSsh -RemoteBody 'systemctl show orca-dws-serve.service -p MainPID --value').Output.Trim()
  # Why by worktree path: the fan-out app is the only electron.exe launched from this checkout.
  $e2eElectron = @(Get-CimInstance Win32_Process -Filter "Name='electron.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($repo) }).Count
  $rec.teardown = [ordered]@{ tunnelSshProcesses = $sshTunnels; tunnelPortListeners = $listener; laptopLocalRuntimeProcesses = $e2eElectron; serveActive = $svcActive; notes = $tearNotes }
  $ok = ($sshTunnels -eq 0 -and $listener -eq 0 -and $e2eElectron -eq 0 -and $svcActive -eq 'active')
  Write-Step 8 TEARDOWN $(if ($ok) { 'OK' } else { 'FAIL' }) "tunnelProcs=$sshTunnels listeners=$listener e2eElectron=$e2eElectron serveActive=$svcActive mainPidBefore=$($rec.mainPidBefore) mainPidAfter=$($rec.mainPidAfter)"
}

$rec.utcEnd = (Get-Date).ToUniversalTime().ToString('o')
if ($block) {
  $rec.rung = 'none'
  $rec.blockedReason = $block
}
$recordPath = Join-Path $state 'run-record.json'
$rec | ConvertTo-Json -Depth 6 | Set-Content -Path $recordPath -Encoding ascii

# 9 EVIDENCE
$glue = Join-Path $PSScriptRoot 'dws-node-manifest-evidence-write.mjs'
$outJson = Join-Path $repo 'docs\dws\phase-5-node-manifest.json'
$outMd = Join-Path $repo 'docs\dws\phase-5-node-manifest.md'
$evidenceModule = Join-Path $PSScriptRoot 'dws-node-manifest-evidence.mjs'
& node $glue $recordPath $outJson $outMd $evidenceModule
$glueExit = $LASTEXITCODE
Write-Step 9 EVIDENCE $(if ($glueExit -eq 0) { 'OK' } else { 'FAIL' }) "glueExit=$glueExit"
exit $glueExit
