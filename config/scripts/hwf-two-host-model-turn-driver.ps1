param([Parameter(Mandatory)][string]$Wt, [string]$Tag = 'r59m',
  [string]$Specs = 'tests/e2e/hwf-two-host-model-turn.spec.ts')
# Row-59 model-turn live leg: the private sshd runs as orca-svc with its real home, so the home the client
# changes (hooks, relay install, a Claude project dir) is backed up first and restored after. The provisioner's
# svc verbs accept only phase-70 roots, hence new-root --phase 70.
$ErrorActionPreference = 'Continue'
$env:PATH = 'C:\Program Files\Git\cmd;' + $env:PATH
Set-Location $Wt
$R = 'config/scripts/hwf-two-host-remote.mjs'
$ev = Join-Path $PSScriptRoot ("d4-ev-$Tag-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Force $ev | Out-Null
$log = Join-Path $ev 'driver.log'
function L($m) { $m | Out-File $log -Append -Encoding utf8 }
function Kv($file, $key) {
  if (-not (Test-Path $file)) { return '' }
  $m = Select-String -Path $file -Pattern "^$key=(.*)$" | Select-Object -First 1
  if ($m) { $m.Matches[0].Groups[1].Value } else { '' }
}
$utf8 = New-Object System.Text.UTF8Encoding($false)

# Refuse before touching GEX44: one Electron at a time, and enough RAM for it.
$freeGb = [math]::Round((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1MB, 2)
L "FREE_RAM_GB=$freeGb"
if ($freeGb -lt 6) { L "HARNESS_FAILED low-ram: $freeGb GB free"; L "EVIDENCE=$ev"; exit 11 }
$busy = @(Get-Process -Name electron -ErrorAction SilentlyContinue)
if ($busy.Count -gt 0) { L "HARNESS_FAILED electron-running: $($busy.Count) process(es)"; L "EVIDENCE=$ev"; exit 11 }

$root = (node $R new-root --phase 70).Trim(); L "ROOT=$root"
if ($root -notmatch '^/tmp/orca-hwf-p70-') { L "HARNESS_FAILED new-root: $root"; L "EVIDENCE=$ev"; exit 10 }
$nonce = (node $R new-nonce).Trim()
node $R create-svc $root --out "$ev\create.txt" *> $null; L "CREATE_EXIT=$LASTEXITCODE"
if ($LASTEXITCODE -ne 0) { L 'HARNESS_FAILED create-svc'; L "EVIDENCE=$ev"; exit 10 }
node $R seed-svc $root $nonce --out "$ev\seed16.txt" *> $null; L "SEED_EXIT=$LASTEXITCODE"
$sl = (node $R seed-local-p16 --nonce $nonce --dir (Join-Path $ev 'local-seed') 2>&1 | Out-String); L "SEEDLOCAL_EXIT=$LASTEXITCODE"
[System.IO.File]::WriteAllText("$ev\seed-local.txt", $sl, $utf8)
node $R fetch-key $root --to "$ev\key" *> $null; L "FETCHKEY_EXIT=$LASTEXITCODE"
$rf = (node $R run-file $root --create "$ev\create.txt" --key "$ev\key\client_key" --out "$ev\run.json" --seed "$ev\seed16.txt" --local-seed "$ev\seed-local.txt" 2>&1 | Out-String)
L "RUNFILE_EXIT=$LASTEXITCODE $($rf.Trim())"
node $R svc-backup $root --out "$ev\svc-before.txt" *> $null; L "BACKUP_EXIT=$LASTEXITCODE"
if ($LASTEXITCODE -ne 0) { L 'HARNESS_FAILED svc-backup'; node $R svc-teardown $root --out "$ev\teardown.txt" *> $null; L "EVIDENCE=$ev"; exit 10 }
node $R witness $root --out "$ev\witness-before.txt" *> $null

try {
  $l = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, 0); $l.Start(); $port = $l.LocalEndpoint.Port; $l.Stop()
  $env:ORCA_HWF_TWO_HOST = '1'; $env:ORCA_HWF_RUN_FILE = "$ev\run.json"; $env:ORCA_HWF_LOCAL_PORT = "$port"; $env:SKIP_BUILD = '1'
  $a = @('test') + ($Specs -split ' ') + @('--config', 'tests/playwright.config.ts', '--project', 'electron-headless', '--workers=1', '--reporter=list')
  & .\node_modules\.bin\playwright.cmd @a *> "$ev\playwright.log"
  L "PLAYWRIGHT_EXIT=$LASTEXITCODE"
  # The spec's own measurements, copied verbatim so the evidence doc quotes the driver log.
  foreach ($line in (Select-String -Path "$ev\playwright.log" -Pattern '^HWF59M_' | ForEach-Object { $_.Line })) { L $line }
} finally {
  node $R svc-state $root --out "$ev\svc-after-leg.txt" *> $null
  node $R svc-teardown $root --out "$ev\teardown.txt" *> $null; L "TEARDOWN_EXIT=$LASTEXITCODE"
  L "REMAINING=$(Kv "$ev\teardown.txt" 'REMAINING')"
  L "PROC_COUNT=$(Kv "$ev\teardown.txt" 'PROC_COUNT')"
  node $R svc-restore $root --out "$ev\svc-restored.txt" *> $null; L "RESTORE_EXIT=$LASTEXITCODE"
  L "HWF_CLAUDE_PROJECTS=$(Kv "$ev\svc-restored.txt" 'HWF_CLAUDE_PROJECTS')"
  node $R witness $root --out "$ev\witness-after.txt" *> $null
  $same = -not (Compare-Object (Get-Content "$ev\witness-before.txt") (Get-Content "$ev\witness-after.txt"))
  L "WITNESS_UNCHANGED=$same"
  $keys = 'SETTINGS_SHA', 'AGENT_HOOKS_SHA', 'ORCA_REMOTE', 'HWF_CLAUDE_PROJECTS', 'SERVE_PID'
  $before = Get-Content "$ev\svc-before.txt" | Where-Object { $k = ($_ -split '=')[0]; $keys -contains $k }
  $after = Get-Content "$ev\svc-restored.txt" | Where-Object { $k = ($_ -split '=')[0]; $keys -contains $k }
  L "SVC_HOME_RESTORED=$(-not (Compare-Object $before $after))"
  L "EVIDENCE=$ev"
}
