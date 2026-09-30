# Phase-7 laptop runner: fences the dws build clone on GEX44 at an exact sha through the phase-2 lane's
# exported primitives, launches federation's named gates DETACHED, polls with a bound, and collects an
# evidence-shaped record. Windows PowerShell 5.1. It never redeploys: no build, no install, no restart.
# ND-1 (named debt): the bundle+ssh lane is the interim legal lane until UWCP S5's dispatcher exists.
# It runs no vitest, tsc or gate locally; every count comes from the box's summary.
#
#   -Action Preflight | Launch | Poll | Collect | Closeout | Assemble
#   -Label attribution | head   (Launch / Poll / Collect)
# Every action ends with exactly one RESULT line: OK, DONE, PENDING, or BLOCKED <rung>.
param(
  [Parameter(Mandatory)][ValidateSet('Preflight', 'Launch', 'Poll', 'Collect', 'Closeout', 'Assemble')][string]$Action,
  [ValidateSet('attribution', 'head')][string]$Label = 'head',
  [int]$BudgetSec = 420,
  [int]$DeadlineMin = 45
)

$ErrorActionPreference = 'Continue'
$script:Git = 'C:\Program Files\Git\cmd\git.exe'
$script:Repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$script:LaneModule = Join-Path $PSScriptRoot 'dws-laptop-remote.psm1'
$script:Clone = '/home/kobii/dws-0104-clone'
$script:OrcaX = '/home/kobii/orca-x'
$script:BaseFence = '865c80de25f4ebbd00ca83c71b0812113b24ac10'
$script:RunRoot = '/home/kobii/dws-0104-clone/.dws-p7-runs'
$script:Node24 = '/home/kobii/.orca-toolchain/node24/bin'
$script:Step = 0
$env:Path = 'C:\Program Files\Git\cmd;' + $env:Path
Import-Module $script:LaneModule -Force

$script:State = Join-Path $env:LOCALAPPDATA 'orca-dws-p7'
$script:RunsDir = Join-Path $script:State 'runs'
foreach ($d in @($script:State, $script:RunsDir)) {
  if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
}

function Write-Step([string]$Name, [string]$Status, [string]$Reason = '') {
  $script:Step++
  Write-Output ("STEP {0} {1} {2} {3}" -f $script:Step, $Name, $Status, $Reason).TrimEnd()
}

function Get-LocalGit([string[]]$GitArgs) {
  $out = & $script:Git -C $script:Repo @GitArgs 2>$null
  return (($out -join "`n").Trim())
}

function Save-Json([string]$Path, $Value) {
  [System.IO.File]::WriteAllText($Path, ($Value | ConvertTo-Json -Depth 10), (New-Object System.Text.UTF8Encoding($false)))
}

# Why: a PowerShell 5.1 writer prepends U+FEFF; a parse failure must not become a permissive default.
function Read-Json([string]$Path) {
  if (-not (Test-Path $Path)) { return $null }
  $text = [System.IO.File]::ReadAllText($Path).TrimStart([char]0xFEFF)
  return ($text | ConvertFrom-Json)
}

function Set-Field($Object, [string]$Name, $Value) {
  $Object | Add-Member -NotePropertyName $Name -NotePropertyValue $Value -Force
}

function Get-LabelRecordPath([string]$Which) {
  $found = Get-ChildItem -Path $script:RunsDir -Filter "p7-*-$Which.json" -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
  if ($found) { return $found.FullName }
  return $null
}

function Exit-Result([string]$Result, [int]$Code) {
  Write-Output "RESULT $Result"
  exit $Code
}

# The lane's -TimeoutSec bounds only the connect phase, so every remote call is bounded in wall-clock
# time here by a job (a separate process that re-imports the module by path). A timed-out call is
# never retried with the same shape.
function Invoke-BoundedDwsSsh([string]$Body, [int]$WallSec = 60) {
  $job = Start-Job -ScriptBlock {
    param($mod, $body, $conn)
    Import-Module $mod -Force
    Invoke-DwsSsh -RemoteBody $body -TimeoutSec $conn
  } -ArgumentList $script:LaneModule, $Body, 20
  if (-not (Wait-Job -Job $job -Timeout $WallSec)) {
    Stop-Job -Job $job
    Remove-Job -Job $job -Force
    return [pscustomobject]@{ TimedOut = $true; ExitCode = -1; Output = '' }
  }
  $received = @(Receive-Job -Job $job)
  Remove-Job -Job $job -Force
  $last = $received | Select-Object -Last 1
  if (-not $last) { return [pscustomobject]@{ TimedOut = $false; ExitCode = -2; Output = '' } }
  return [pscustomobject]@{ TimedOut = $false; ExitCode = [int]$last.ExitCode; Output = [string]$last.Output }
}

function Invoke-BoundedDwsScpTo([string]$LocalPath, [string]$RemotePath, [int]$WallSec = 180) {
  $job = Start-Job -ScriptBlock {
    param($mod, $local, $remote)
    Import-Module $mod -Force
    Invoke-DwsScpTo -LocalPath $local -RemotePath $remote
  } -ArgumentList $script:LaneModule, $LocalPath, $RemotePath
  if (-not (Wait-Job -Job $job -Timeout $WallSec)) {
    Stop-Job -Job $job
    Remove-Job -Job $job -Force
    return [pscustomobject]@{ TimedOut = $true; ExitCode = -1 }
  }
  $received = @(Receive-Job -Job $job)
  Remove-Job -Job $job -Force
  $code = $received | Select-Object -Last 1
  return [pscustomobject]@{ TimedOut = $false; ExitCode = $(if ($null -eq $code) { -2 } else { [int]$code }) }
}

function Save-Blocked($Record, [string]$Path, [string]$Rung, [string]$Reason) {
  Set-Field $Record 'blocked' ([pscustomobject]@{ rung = $Rung; reason = $Reason })
  Save-Json $Path $Record
  Write-Step 'BLOCKED' 'FAIL' "$Rung $Reason"
  Exit-Result "BLOCKED $Rung" 4
}

function Add-Timeout($Record, [string]$What) {
  Set-Field $Record 'timeouts' (@($Record.timeouts) + $What | Where-Object { $_ })
}

function ConvertTo-LfCopy([string]$Source, [string]$Name) {
  $text = [System.IO.File]::ReadAllText($Source).Replace("`r`n", "`n")
  $copy = Join-Path $script:State $Name
  [System.IO.File]::WriteAllText($copy, $text, (New-Object System.Text.UTF8Encoding($false)))
  return $copy
}

function Split-Lines([string]$Text) {
  return @(($Text -replace "`r", '') -split "`n" | Where-Object { $_.Trim() -ne '' })
}

function Invoke-Preflight {
  $facts = [ordered]@{ utc = (Get-Date).ToUniversalTime().ToString('o') }
  $bodies = [ordered]@{
    cloneHead   = "git -C $script:Clone rev-parse HEAD"
    vitestPresent = "test -e $script:Clone/node_modules/vitest/vitest.mjs && echo YES || echo NO"
    nodeModulesLink = "readlink -f $script:Clone/node_modules"
    diskAvail   = 'df --output=avail -BG /'
    nodeVersion = "PATH=$script:Node24" + ':$PATH node -v'
  }
  $failed = ''
  foreach ($key in $bodies.Keys) {
    $r = Invoke-BoundedDwsSsh -Body $bodies[$key] -WallSec 60
    if ($r.TimedOut -or $r.ExitCode -ne 0) {
      Write-Step "PROBE-$key" 'FAIL' $(if ($r.TimedOut) { 'wall-clock-timeout' } else { "exit $($r.ExitCode)" })
      $failed = $key
      break
    }
    $facts[$key] = $r.Output.Trim()
    Write-Step "PROBE-$key" 'OK'
  }
  if (-not $failed -and $facts['vitestPresent'] -ne 'YES') { $failed = 'vitestPresent' }
  if (-not $failed -and -not ([string]$facts['nodeVersion']).StartsWith('v24')) { $failed = 'nodeVersion' }
  if (-not $failed) {
    $attr = Get-LocalGit @('rev-parse', '--verify', 'orca-x/agent-federation^{commit}')
    $probe = Invoke-BoundedDwsSsh -Body "git -C $script:Clone cat-file -t $attr" -WallSec 60
    # Why informational: the head bundle lands the attribution objects during Launch, so absence here is expected.
    $facts['attributionObjectPresent'] = (-not $probe.TimedOut) -and $probe.ExitCode -eq 0
    Write-Step 'PROBE-attributionObject' 'OK' "present=$($facts['attributionObjectPresent'])"
  }
  $facts['blocked'] = $null
  if ($failed) { $facts['blocked'] = [ordered]@{ rung = 'preflight'; reason = "probe $failed failed" } }
  Save-Json (Join-Path $script:State 'preflight.json') ([pscustomobject]$facts)
  if ($failed) { Exit-Result 'BLOCKED preflight' 4 }
  Exit-Result 'OK' 0
}

function Invoke-Launch {
  $head = Get-LocalGit @('rev-parse', 'HEAD')
  $attr = Get-LocalGit @('rev-parse', '--verify', 'orca-x/agent-federation^{commit}')
  $short = $head.Substring(0, 9)
  $recordPath = Join-Path $script:RunsDir "p7-$short-$Label.json"
  $record = [pscustomobject]@{
    label = $Label; gatedSha = $head; attributionSha = $attr; shortSha = $short
    timeouts = @(); blocked = $null; fence = $null; runDir = $null
  }
  $dirty = Get-LocalGit @('status', '--porcelain', '--untracked-files=no', '--', 'src', 'config', 'docs')
  if ($dirty) { Save-Blocked $record $recordPath 'tree-dirty' 'tracked edits under src/ config/ docs/ at Launch' }
  & $script:Git -C $script:Repo merge-base --is-ancestor $attr $head 2>$null
  if ($LASTEXITCODE -ne 0) { Save-Blocked $record $recordPath 'attribution-fence' 'orca-x/agent-federation is not an ancestor of HEAD' }
  Write-Step 'RESOLVE' 'OK' "head=$head attribution=$attr"

  $bundle = Join-Path $script:State "dws-p7-$short.bundle"
  & $script:Git -C $script:Repo bundle create $bundle HEAD "^$script:BaseFence" 2>$null | Out-Null
  if ($LASTEXITCODE -ne 0) { Save-Blocked $record $recordPath 'bundle' 'git bundle create failed' }
  Write-Step 'BUNDLE' 'OK' $bundle

  $mk = Invoke-BoundedDwsSsh -Body "mkdir -p $script:RunRoot" -WallSec 60
  if ($mk.TimedOut) { Add-Timeout $record 'launch-mkdir'; Save-Blocked $record $recordPath 'ssh' 'wall-clock-timeout' }
  if ($mk.ExitCode -ne 0) { Save-Blocked $record $recordPath 'ssh' "mkdir exit $($mk.ExitCode)" }

  $provision = ConvertTo-LfCopy (Join-Path $PSScriptRoot 'dws-gex44-serve-provision.sh') "dws-p7-provision-$short.sh"
  $gates = ConvertTo-LfCopy (Join-Path $PSScriptRoot 'dws-federation-gates-remote.sh') "dws-p7-gates-$short.sh"
  $remoteBundle = "$script:RunRoot/dws-p7-$short.bundle"
  $remoteBoot = "$script:RunRoot/dws-p7-provision-$short.sh"
  $remoteGates = "$script:RunRoot/dws-p7-gates-$short.sh"
  $copies = @(@($bundle, $remoteBundle), @($provision, $remoteBoot), @($gates, $remoteGates))
  foreach ($c in $copies) {
    $r = Invoke-BoundedDwsScpTo -LocalPath $c[0] -RemotePath $c[1] -WallSec 180
    if ($r.TimedOut) { Add-Timeout $record "launch-scp-$($c[1])"; Save-Blocked $record $recordPath 'ssh' 'wall-clock-timeout' }
    if ($r.ExitCode -ne 0) { Save-Blocked $record $recordPath 'ssh' "scp exit $($r.ExitCode)" }
  }
  Write-Step 'COPY' 'OK' 'bundle, bootstrap provision script, gates script'

  $fence = Invoke-BoundedDwsSsh -Body "bash $remoteBoot fetch-bundle $remoteBundle $head $short" -WallSec 180
  if ($fence.TimedOut) { Add-Timeout $record 'launch-fetch-bundle'; Save-Blocked $record $recordPath 'ssh' 'wall-clock-timeout' }
  $fenceText = $fence.Output
  $fenceOk = (Split-Lines $fenceText | Where-Object { $_ -match '^FENCE_OK ' } | Select-Object -First 1)
  $before = ((Split-Lines $fenceText | Where-Object { $_ -match '^ORCA_X_HEAD_BEFORE=' } | Select-Object -First 1) -replace '^ORCA_X_HEAD_BEFORE=', '')
  $after = ((Split-Lines $fenceText | Where-Object { $_ -match '^ORCA_X_HEAD_AFTER=' } | Select-Object -First 1) -replace '^ORCA_X_HEAD_AFTER=', '')
  $discarded = [bool](Split-Lines $fenceText | Where-Object { $_ -match '^CLONE_DIRTY_DISCARDED' })
  Set-Field $record 'fence' ([pscustomobject]@{
      sha = $head; label = $Label; localHead = $head; remoteRevParse = $null; fenceOk = $fenceOk
      orcaXHeadBefore = $before; orcaXHeadAfter = $after; cloneDirtyDiscarded = $discarded
      summaryText = ''; failedTests = @(); tscErrors = @(); skippedFiles = @(); treeClean = $null
      utcStart = (Get-Date).ToUniversalTime().ToString('o'); utcEnd = $null; blocked = $null
    })
  if ($fenceOk -ne "FENCE_OK $head") { Save-Blocked $record $recordPath 'fence-mismatch' "fence output lacked FENCE_OK $head" }
  if ($before -ne $after) { Save-Blocked $record $recordPath 'fence-mismatch' 'orca-x head moved during the fence' }
  $rev = Invoke-BoundedDwsSsh -Body "git -C $script:Clone rev-parse HEAD" -WallSec 60
  if ($rev.TimedOut) { Add-Timeout $record 'launch-rev-parse'; Save-Blocked $record $recordPath 'ssh' 'wall-clock-timeout' }
  Set-Field $record.fence 'remoteRevParse' $rev.Output.Trim()
  if ($rev.Output.Trim() -ne $head) { Save-Blocked $record $recordPath 'fence-mismatch' 'independent remote rev-parse differs from local HEAD' }
  Write-Step 'FENCE' 'OK' "FENCE_OK and independent rev-parse equal $head"

  $runDir = "$script:RunRoot/$short-$Label"
  $gateSha = $head
  $modeArg = ''
  if ($Label -eq 'attribution') { $gateSha = $attr; $modeArg = ' --checkout' }
  $body = "mkdir -p $runDir; nohup bash $remoteGates $gateSha $Label $runDir$modeArg > $runDir.out 2>&1 < /dev/null & disown; echo LAUNCHED"
  $go = Invoke-BoundedDwsSsh -Body $body -WallSec 60
  if ($go.TimedOut) { Add-Timeout $record 'launch-detach'; Save-Blocked $record $recordPath 'ssh' 'wall-clock-timeout' }
  if ($go.Output -notmatch 'LAUNCHED') { Save-Blocked $record $recordPath 'ssh' 'detached launch did not answer LAUNCHED' }
  $now = (Get-Date).ToUniversalTime()
  Set-Field $record 'runDir' $runDir
  Set-Field $record 'gateSha' $gateSha
  Set-Field $record 'launchedAtUtc' $now.ToString('o')
  Set-Field $record 'deadlineUtc' $now.AddMinutes($DeadlineMin).ToString('o')
  Set-Field $record.fence 'sha' $gateSha
  Save-Json $recordPath $record
  Write-Step 'LAUNCH' 'OK' "detached at $runDir"
  Exit-Result 'OK' 0
}

function Get-LabelRecord {
  $path = Get-LabelRecordPath $Label
  if (-not $path) { Write-Step 'RECORD' 'FAIL' "no run record for $Label"; Exit-Result 'BLOCKED launch' 4 }
  return @($path, (Read-Json $path))
}

function Invoke-Poll {
  $path, $record = Get-LabelRecord
  if ($record.blocked) { Write-Step 'POLL' 'SKIP' 'launch already blocked'; Exit-Result "BLOCKED $($record.blocked.rung)" 4 }
  $deadline = [datetime]::Parse($record.deadlineUtc).ToUniversalTime()
  $stop = (Get-Date).AddSeconds($BudgetSec)
  $lastFailure = ''
  while ($true) {
    $r = Invoke-BoundedDwsSsh -Body "test -f $($record.runDir)/DONE && echo DONE || echo PENDING" -WallSec 60
    if ($r.TimedOut) { Add-Timeout $record 'poll'; Save-Blocked $record $path 'ssh' 'wall-clock-timeout' }
    if ($r.ExitCode -ne 0) {
      $shape = "exit $($r.ExitCode)"
      if ($lastFailure -eq $shape) { Save-Blocked $record $path 'ssh' "two identical poll failures ($shape)" }
      $lastFailure = $shape
    } else {
      $lastFailure = ''
      if ($r.Output -match 'DONE') { Write-Step 'POLL' 'OK' 'DONE marker present'; Exit-Result 'DONE' 0 }
    }
    if ((Get-Date).ToUniversalTime() -gt $deadline) { Save-Blocked $record $path 'gates-timeout' "overall deadline $($record.deadlineUtc) passed" }
    if ((Get-Date) -gt $stop) { Write-Step 'POLL' 'SKIP' 'budget spent, still pending'; Exit-Result 'PENDING' 3 }
    Start-Sleep -Seconds 15
  }
}

function Read-RemoteFile($Record, [string]$Path, [string]$Name) {
  $r = Invoke-BoundedDwsSsh -Body "cat $($Record.runDir)/$Name 2>/dev/null; true" -WallSec 60
  if ($r.TimedOut) { Add-Timeout $Record "collect-$Name"; Save-Blocked $Record $Path 'ssh' 'wall-clock-timeout' }
  return ($r.Output -replace "`r", '')
}

function Invoke-Collect {
  $path, $record = Get-LabelRecord
  if ($record.blocked) { Write-Step 'COLLECT' 'SKIP' 'launch already blocked'; Exit-Result "BLOCKED $($record.blocked.rung)" 4 }
  $done = Invoke-BoundedDwsSsh -Body "test -f $($record.runDir)/DONE && echo DONE || echo PENDING" -WallSec 60
  if ($done.TimedOut) { Add-Timeout $record 'collect-done'; Save-Blocked $record $path 'ssh' 'wall-clock-timeout' }
  if ($done.Output -notmatch 'DONE') { Write-Step 'COLLECT' 'SKIP' 'not finished'; Exit-Result 'PENDING' 3 }
  $summary = Read-RemoteFile $record $path 'summary.txt'
  $failed = Split-Lines (Read-RemoteFile $record $path 'vitest-failed.txt')
  $tsc = Split-Lines (Read-RemoteFile $record $path 'tsc-node-errors.txt')
  $skipped = Split-Lines (Read-RemoteFile $record $path 'vitest-skipped-files.txt')
  $treeLine = Split-Lines $summary | Where-Object { $_ -match '^TREE_CLEAN=' } | Select-Object -First 1
  $rev = Split-Lines $summary | Where-Object { $_ -match '^REV_BEFORE_GATES ' } | Select-Object -First 1
  $blockedLine = Split-Lines $summary | Where-Object { $_ -match '^BLOCKED ' } | Select-Object -First 1
  $fence = $record.fence
  Set-Field $fence 'summaryText' $summary
  Set-Field $fence 'failedTests' @($failed)
  Set-Field $fence 'tscErrors' @($tsc)
  Set-Field $fence 'skippedFiles' @($skipped)
  Set-Field $fence 'treeClean' ($treeLine -eq 'TREE_CLEAN=1')
  Set-Field $fence 'utcEnd' (Get-Date).ToUniversalTime().ToString('o')
  # Why: the attribution fence's rev-parse is the box's own reading taken by the gates script; the head fence keeps the independent Launch reading.
  if ($Label -eq 'attribution' -and $rev) { Set-Field $fence 'remoteRevParse' ($rev -replace '^REV_BEFORE_GATES ', '') }
  if ($blockedLine) {
    $parts = $blockedLine -split ' ', 3
    Set-Field $fence 'blocked' ([pscustomobject]@{ rung = $parts[1]; reason = $(if ($parts.Count -gt 2) { $parts[2] } else { $parts[1] }) })
  }
  Set-Field $record 'serveDeployedSha' ((Read-Json (Join-Path (Get-DwsStateDir) 'deployed.json')).sha)
  Save-Json $path $record
  Write-Step 'COLLECT' 'OK' "failed=$(@($failed).Count) tscErrors=$(@($tsc).Count) skippedFiles=$(@($skipped).Count)"
  Exit-Result 'DONE' 0
}

function Invoke-Closeout {
  $closeout = [pscustomobject]@{ cloneHeadAtEnd = $null; orcaXHeadAtEnd = $null; cloneLeftAtGatedSha = $false }
  $r = Invoke-BoundedDwsSsh -Body "git -C $script:Clone rev-parse HEAD; git -C $script:OrcaX rev-parse HEAD" -WallSec 60
  if ($r.TimedOut -or $r.ExitCode -ne 0) {
    Write-Step 'CLOSEOUT' 'FAIL' 'ssh read failed'
    Exit-Result 'BLOCKED ssh' 4
  }
  $lines = Split-Lines $r.Output
  $head = Get-LocalGit @('rev-parse', 'HEAD')
  Set-Field $closeout 'cloneHeadAtEnd' $lines[0]
  Set-Field $closeout 'orcaXHeadAtEnd' $lines[1]
  Set-Field $closeout 'cloneLeftAtGatedSha' ($lines[0] -eq $head)
  $headPath = Get-LabelRecordPath 'head'
  $headRecord = if ($headPath) { Read-Json $headPath } else { $null }
  $attrPath = Get-LabelRecordPath 'attribution'
  $attrRecord = if ($attrPath) { Read-Json $attrPath } else { $null }
  $rung = if (-not $headRecord) { 'head-fence (never ran)' } elseif ($headRecord.blocked) { $headRecord.blocked.rung } else { $null }
  if ($rung -and $attrRecord) {
    Set-Field $closeout 'cloneLeftNote' "the build clone was left at $($attrRecord.attributionSha) (the attribution fence); the head fence was BLOCKED at $rung"
  }
  Save-Json (Join-Path $script:State 'closeout.json') $closeout
  Write-Step 'CLOSEOUT' 'OK' "clone=$($lines[0]) orca-x=$($lines[1])"
  Exit-Result 'OK' 0
}

function Invoke-Assemble {
  $records = @{}
  foreach ($which in @('attribution', 'head')) {
    $p = Get-LabelRecordPath $which
    $records[$which] = $(if ($p) { Read-Json $p } else { $null })
  }
  $preflight = Read-Json (Join-Path $script:State 'preflight.json')
  $closeout = Read-Json (Join-Path $script:State 'closeout.json')
  $anyRecord = @($records['head'], $records['attribution']) | Where-Object { $_ } | Select-Object -First 1
  $timeouts = @()
  $fences = [ordered]@{}
  foreach ($which in @('attribution', 'head')) {
    if ($records[$which]) {
      $timeouts += @($records[$which].timeouts)
      $fence = $records[$which].fence
      if (-not $fence -and $records[$which].blocked) {
        $fence = [pscustomobject]@{ sha = $records[$which].gatedSha; label = $which; summaryText = ''; blocked = $records[$which].blocked }
      }
      if ($fence -and $records[$which].blocked -and -not $fence.blocked) { Set-Field $fence 'blocked' $records[$which].blocked }
      $fences[$which] = $fence
    }
  }
  $top = [ordered]@{
    headSha = $(if ($anyRecord) { $anyRecord.gatedSha } else { Get-LocalGit @('rev-parse', 'HEAD') })
    federationHead = $(if ($anyRecord) { $anyRecord.attributionSha } else { $null })
    serveDeployedSha = $(if ($records['head']) { $records['head'].serveDeployedSha } else { $null })
    containment = Read-Json (Join-Path $script:State 'containment.json')
    ownership = Read-Json (Join-Path $script:State 'ownership.json')
    fences = $fences
    timeouts = @($timeouts | Where-Object { $_ })
    blocked = $(if ($preflight -and $preflight.blocked) { $preflight.blocked } else { $null })
    preflight = $preflight
  }
  if ($closeout) {
    $top['cloneHeadAtEnd'] = $closeout.cloneHeadAtEnd
    $top['orcaXHeadAtEnd'] = $closeout.orcaXHeadAtEnd
    $top['cloneLeftAtGatedSha'] = $closeout.cloneLeftAtGatedSha
    if ($closeout.cloneLeftNote) { $top['cloneLeftNote'] = $closeout.cloneLeftNote }
  }
  $recordFile = Join-Path $script:State 'p7-run-record.json'
  Save-Json $recordFile ([pscustomobject]$top)
  $writer = Join-Path $PSScriptRoot 'dws-federation-remeasure-evidence-write.mjs'
  $outJson = Join-Path $script:Repo 'docs\dws\phase-7-federation-remeasure.json'
  $outMd = Join-Path $script:Repo 'docs\dws\phase-7-federation-remeasure.md'
  & node $writer --record $recordFile --out-json $outJson --out-md $outMd
  if ($LASTEXITCODE -ne 0) { Write-Step 'ASSEMBLE' 'FAIL' 'evidence writer refused'; Exit-Result 'BLOCKED evidence-write' 4 }
  Write-Step 'ASSEMBLE' 'OK' 'docs/dws/phase-7-federation-remeasure.{json,md} written'
  Exit-Result 'DONE' 0
}

switch ($Action) {
  'Preflight' { Invoke-Preflight }
  'Launch' { Invoke-Launch }
  'Poll' { Invoke-Poll }
  'Collect' { Invoke-Collect }
  'Closeout' { Invoke-Closeout }
  'Assemble' { Invoke-Assemble }
}
