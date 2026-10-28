param([int]$Port = 47394, [int]$FakeApiPort = 47411)
$ErrorActionPreference = 'Stop'
$root = Join-Path $env:TEMP ("sendp0-serve-" + (Get-Date -Format 'yyyyMMddHHmmss'))
$ud = Join-Path $root 'userdata'; $home2 = Join-Path $root 'home'; $work = Join-Path $root 'work'; $cfg = Join-Path $root 'cfg'
New-Item -ItemType Directory -Force $ud, $home2, $work, $cfg | Out-Null
& 'C:\Program Files\Git\cmd\git.exe' -C $work init -q
Set-Content -Path (Join-Path $work 'README.md') -Value 'send-p0 trace workspace' -Encoding ascii
$key = 'sk-ant-api03-' + ('x' * 80) + 'SENDP0H1KEYAAAAAAAAAA'
$projects = @{}
foreach ($p in @($work, ($work -replace '\\', '/'))) { $projects[$p] = @{ hasTrustDialogAccepted = $true; hasCompletedProjectOnboarding = $true; allowedTools = @() } }
$claudeJson = @{ hasCompletedOnboarding = $true; theme = 'dark'; numStartups = 5; customApiKeyResponses = @{ approved = @($key.Substring($key.Length - 20)); rejected = @() }; projects = $projects } | ConvertTo-Json -Depth 6
[IO.File]::WriteAllText((Join-Path $cfg '.claude.json'), $claudeJson, (New-Object Text.UTF8Encoding($false)))
Get-ChildItem env: | Where-Object { $_.Name -like 'CLAUDE_CODE_*' -or $_.Name -eq 'CLAUDECODE' } | ForEach-Object { Remove-Item "env:$($_.Name)" }
$env:ORCA_E2E_USER_DATA_DIR = $ud; $env:ORCA_E2E_HOME_DIR = $home2; $env:USERPROFILE = $home2; $env:HOME = $home2
$env:CLAUDE_CONFIG_DIR = $cfg; $env:ANTHROPIC_API_KEY = $key; $env:ANTHROPIC_BASE_URL = "http://127.0.0.1:$FakeApiPort"
$env:CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'; $env:DISABLE_AUTOUPDATER = '1'; $env:DISABLE_TELEMETRY = '1'
@{ root = $root; userData = $ud; work = $work; port = $Port; fakeApiPort = $FakeApiPort } | ConvertTo-Json | Set-Content -Path (Join-Path $PSScriptRoot 'serve-host.json') -Encoding ascii
$proc = Start-Process -FilePath 'C:\owx-pc\node_modules\electron\dist\electron.exe' -ArgumentList @('C:\owx-pc', '--serve', '--serve-json', '--serve-port', "$Port", '--serve-bind-host', '127.0.0.1', '--serve-pairing-address', '127.0.0.1', '--serve-mobile-pairing') -RedirectStandardOutput (Join-Path $PSScriptRoot 'serve-host.out') -RedirectStandardError (Join-Path $PSScriptRoot 'serve-host.err') -NoNewWindow -PassThru
"pid=$($proc.Id)"
$proc.WaitForExit()
