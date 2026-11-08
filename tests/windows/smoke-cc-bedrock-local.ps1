# smoke-cc-bedrock-local.ps1 - offline smoke test of tools/cc-bedrock-local.ps1 on a Windows PC.
#
# Runs the CLI against a throwaway profile directory (USERPROFILE is redirected for
# the child processes only), so the real ~\.claude, ~\.codex, ~\.aws and the
# registry are not touched. No network, no Cognito, no dashboard.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\smoke-cc-bedrock-local.ps1 [-Cli <path>] [-Shell pwsh] [-Keep]
#
# -Cli    path to cc-bedrock-local.ps1 (default: ..\..\tools\ or next to this script)
# -Shell  powershell.exe (default, Windows PowerShell 5.1) or pwsh (PowerShell 7)
# -Keep   keep the throwaway directory for inspection
#
# Exit 0 when every check passes. Keep this file pure ASCII (see tools/CLAUDE.md).
param(
  [string]$Cli = '',
  [string]$Shell = 'powershell.exe',
  [switch]$Keep
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

if (-not $Cli) {
  foreach ($c in @((Join-Path $PSScriptRoot '..\..\tools\cc-bedrock-local.ps1'), (Join-Path $PSScriptRoot 'cc-bedrock-local.ps1'))) {
    if (Test-Path -LiteralPath $c) { $Cli = $c; break }
  }
}
if (-not $Cli -or -not (Test-Path -LiteralPath $Cli)) { throw 'cc-bedrock-local.ps1 not found - pass -Cli <path>' }
$Cli = (Resolve-Path -LiteralPath $Cli).Path
if (-not (Get-Command $Shell -ErrorAction SilentlyContinue)) { throw "$Shell not found" }

$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$script:Failed = 0
$script:Passed = 0
function Check([string]$name, [bool]$ok, [string]$detail = '') {
  if ($ok) { $script:Passed++; [Console]::WriteLine("PASS  $name") }
  else { $script:Failed++; [Console]::WriteLine("FAIL  $name"); if ($detail) { [Console]::WriteLine("      $detail") } }
}
function Put([string]$path, [string]$text) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $path) | Out-Null
  [IO.File]::WriteAllText($path, $text, $Utf8NoBom)
}
function Text([string]$path) { if (Test-Path -LiteralPath $path) { return [IO.File]::ReadAllText($path) } return '' }
function HasBom([string]$path) {
  $b = [IO.File]::ReadAllBytes($path)
  return ($b.Length -ge 3 -and $b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF)
}

# Throwaway home. A space in the name checks the quoting of the credential command.
$Root = Join-Path ([IO.Path]::GetTempPath()) ("ccbl smoke " + [Guid]::NewGuid().ToString('N').Substring(0, 8))
$H = Join-Path $Root 'home'
$Bin = Join-Path $H '.local\bin'
New-Item -ItemType Directory -Force -Path $Bin | Out-Null
$CliCopy = Join-Path $Bin 'cc-bedrock-local.ps1'
Copy-Item -LiteralPath $Cli -Destination $CliCopy
Unblock-File -LiteralPath $CliCopy -ErrorAction SilentlyContinue

$CfgDir = Join-Path $H '.config\cc-bedrock'
$SettingsFile = Join-Path $H '.claude\settings.json'
$CodexFile = Join-Path $H '.codex\config.toml'
$MantleFile = Join-Path $H '.codex\mantle.config.toml'
$RuntimeFile = Join-Path $H '.codex\runtime.config.toml'
$AwsConfig = Join-Path $H '.aws\config'

Put (Join-Path $CfgDir 'config') "DASHBOARD_URL=https://dashboard.example.invalid`nCOGNITO_CLIENT_ID=client`nEMAIL=user@example.com`nCODEX_MODEL=global.openai.gpt-6.1-sol`n"
$OrigSettings = '{"permissions":{"allow":["Bash(ls)"]},"env":{"FOO":"1"}}'
Put $SettingsFile ($OrigSettings + "`n")
Put $CodexFile "model = `"gpt-5`"`napproval_policy = `"never`"`n`n[profiles.work]`nmodel = `"o3`"`n`n[model_providers.amazon-bedrock-runtime.aws]`nregion = `"us-east-1`"`n"
Put (Join-Path $CfgDir 'state.json') '{"credentials":{"accessKeyId":"AKIA","secretAccessKey":"SECRET","sessionToken":"TOKEN","expiration":"2099-01-01T00:00:00Z"},"mantle":{"enabled":true,"projectId":"proj_123","region":"us-east-1","model":"openai.gpt-6.1-sol"}}'

# Child processes inherit this process's environment; redirect it, restore in finally.
$EnvNames = @('USERPROFILE', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'CC_BEDROCK_DASHBOARD_URL', 'CC_BEDROCK_EMAIL', 'CC_BEDROCK_KEEPALIVE_NAME',
  'AWS_PROFILE_NAME', 'AWS_REGION', 'AWS_PROFILE', 'AWS_CONFIG_FILE', 'AWS_SHARED_CREDENTIALS_FILE')
$Saved = @{}
foreach ($n in $EnvNames) { $Saved[$n] = [Environment]::GetEnvironmentVariable($n, 'Process') }

function Run([string]$exe, [string[]]$argList) {
  $o = Join-Path $Root 'stdout.txt'; $e = Join-Path $Root 'stderr.txt'
  $p = Start-Process -FilePath $exe -ArgumentList $argList -NoNewWindow -Wait -PassThru -RedirectStandardOutput $o -RedirectStandardError $e
  $out = Text $o; $err = Text $e
  return [pscustomobject]@{ Code = $p.ExitCode; Out = $out; Err = $err }
}
function RunCli([string[]]$a) {
  return Run $Shell (@('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', "`"$CliCopy`"") + $a)
}

try {
  foreach ($n in $EnvNames) { [Environment]::SetEnvironmentVariable($n, $null, 'Process') }
  $env:USERPROFILE = $H
  # Keep-alive under a throwaway name: the task and the Startup/Start menu entries are
  # per real user (not under USERPROFILE), and the user's own keep-alive must survive.
  $KaName = 'ccbl-smoke-' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
  $env:CC_BEDROCK_KEEPALIVE_NAME = $KaName
  $KaStartup = Join-Path ([Environment]::GetFolderPath('Startup')) "$KaName.vbs"
  $KaShortcut = Join-Path ([Environment]::GetFolderPath('Programs')) "$KaName sign in.lnk"
  [Console]::WriteLine("CLI:   $Cli")
  [Console]::WriteLine("Shell: $Shell $((& $Shell -NoProfile -Command '$PSVersionTable.PSVersion.ToString()'))")
  [Console]::WriteLine("Home:  $H")
  [Console]::WriteLine('')

  # An explicit ACE from before the install (BUILTIN\Users read, by SID so it works on
  # any Windows language) must be gone after setup: /inheritance:r alone would keep it.
  & icacls.exe $CfgDir /grant '*S-1-5-32-545:(OI)(CI)R' | Out-Null

  # 1. setup
  $r = RunCli @('setup')
  Check 'setup exits 0' ($r.Code -eq 0) ("exit=$($r.Code) stderr=$($r.Err)")
  if ($r.Code -ne 0) { throw 'setup failed; later checks would be noise' }

  # 2. Claude settings.json
  Check 'settings.json has no BOM' (-not (HasBom $SettingsFile))
  $s = (Text $SettingsFile) | ConvertFrom-Json
  Check 'settings.json keeps user keys' (($s.env.FOO -eq '1') -and (@($s.permissions.allow) -contains 'Bash(ls)'))
  Check 'settings.json env CLAUDE_CODE_USE_BEDROCK=1' ($s.env.CLAUDE_CODE_USE_BEDROCK -eq '1')
  Check 'settings.json denies Read of the cc-bedrock dir' (@($s.permissions.deny) -contains 'Read(~/.config/cc-bedrock/**)')
  $cmd = [string]$s.awsCredentialExport
  # A path with a space (this root) uses -EncodedCommand; decode it before checking.
  $plain = $cmd
  if ($cmd -cmatch '-EncodedCommand (\S+)$') { $plain = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($Matches[1])) }
  Check 'awsCredentialExport calls this CLI' ($plain.Contains('credential-process') -and $plain.Contains(($CliCopy -replace '\\', '/'))) $cmd
  Check 'space in path uses -EncodedCommand' ($cmd.Contains(' -EncodedCommand ')) $cmd
  # The Rust AWS SDK (Codex) passes credential_process to cmd.exe /C as one escaped
  # argument; any double quote in it breaks the -File path.
  Check 'credential command has no double quotes (Codex on Windows)' (-not $cmd.Contains('"')) $cmd

  # 3. Codex config.toml + mantle
  $t = Text $CodexFile
  Check 'config.toml has no BOM' (-not (HasBom $CodexFile))
  # With a mantle grant, mantle is the default (ADR-014 section 9, amended 2026-11-03).
  Check 'config.toml defaults to amazon-bedrock (mantle)' ($t -cmatch '(?m)^model_provider = "amazon-bedrock"  # managed by cc-bedrock-local$') $t
  Check 'config.toml web_search live' ($t -cmatch '(?m)^web_search = "live"  # managed by cc-bedrock-local$')
  Check 'config.toml mantle project header' ($t -cmatch '(?m)^OpenAI-Project = "proj_123"$')
  $rt = Text $RuntimeFile
  Check 'runtime.config.toml written (codex -p runtime)' ($rt -cmatch '(?m)^model_provider = "amazon-bedrock-runtime"$') $rt
  Check 'config.toml aws profile/region' ($t -cmatch '(?m)^\[model_providers\.amazon-bedrock-runtime\.aws\]  # managed by cc-bedrock-local\r?\nprofile = "cc-bedrock"\r?\nregion = "ap-northeast-2"') $t
  Check 'config.toml keeps [profiles.work]' ($t -cmatch '(?m)^\[profiles\.work\]\r?\nmodel = "o3"')
  Check 'config.toml has no CRLF (same bytes as bash)' (-not $t.Contains("`r"))
  # Native Windows: no permission profile (the Windows sandbox cannot enforce a
  # denied read path, and Codex refuses such a profile at start).
  Check 'config.toml has no Codex permission profile on Windows' ((-not $t.Contains('default_permissions')) -and (-not $t.Contains('[permissions.cc-bedrock'))) $t
  $m = Text $MantleFile
  Check 'mantle.config.toml written' ($m -cmatch '(?m)^OpenAI-Project = "proj_123"$')
  Check 'mantle header em dash is UTF-8' ((([IO.File]::ReadAllBytes($MantleFile)[30..32]) -join ',') -eq '226,128,148') ([IO.File]::ReadAllLines($MantleFile)[0])

  # 4. AWS profile
  $a = Text $AwsConfig
  Check '~/.aws/config credential_process' ($a.Contains("credential_process = $cmd")) $a

  # 4b. Session-report Stop hook (same command form as awsCredentialExport)
  $stopGroups = @()
  if ($s.PSObject.Properties['hooks'] -and $s.hooks.PSObject.Properties['Stop']) { $stopGroups = @($s.hooks.Stop) }
  $hookCmd = ''; $hookTimeout = 0
  if ($stopGroups.Count -eq 1) { $hookCmd = [string]$stopGroups[0].hooks[0].command; $hookTimeout = [int]$stopGroups[0].hooks[0].timeout }
  $hookPlain = $hookCmd
  if ($hookCmd -cmatch '-EncodedCommand (\S+)$') { $hookPlain = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($Matches[1])) }
  Check 'setup installs the Stop hook (session-report --quiet, timeout 30)' ($hookPlain.Contains('session-report --quiet') -and $hookPlain.Contains(($CliCopy -replace '\\', '/')) -and $hookTimeout -eq 30) $hookCmd
  Check 'Stop hook has no double quotes' (-not $hookCmd.Contains('"')) $hookCmd

  # 4c. session-report dry run over a tiny fixture transcript (no network, no state)
  $day = [DateTime]::UtcNow.AddDays(-1).ToString('yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture)
  $tr = Join-Path $H '.claude\projects\smoke-proj\smoke-sess.jsonl'
  $u1 = '{"type":"user","sessionId":"smoke-sess","timestamp":"' + $day + 'T10:00:00.000Z","message":{"role":"user","content":"hi"}}'
  $u2 = '{"type":"user","sessionId":"smoke-sess","timestamp":"' + $day + 'T10:00:01.000Z","isMeta":true,"message":{"role":"user","content":"meta"}}'
  $a1 = '{"type":"assistant","sessionId":"smoke-sess","timestamp":"' + $day + 'T10:00:02.000Z","message":{"id":"msg_1","model":"claude-test","usage":{"input_tokens":3,"output_tokens":4,"cache_read_input_tokens":5,"cache_creation_input_tokens":6}}}'
  $a2 = '{"type":"assistant","sessionId":"smoke-sess","timestamp":"' + $day + 'T10:00:03.000Z","message":{"id":"msg_1","model":"claude-test","usage":{"input_tokens":3,"output_tokens":9,"cache_read_input_tokens":5,"cache_creation_input_tokens":6}}}'
  Put $tr (($u1, $u2, $a1, $a2) -join "`n")   # last line incomplete (no newline): not counted yet
  $r = RunCli @('session-report', '--dry-run', '--sweep')
  $dr = $null
  try { $dr = $r.Out | ConvertFrom-Json } catch { }
  $okA = $false
  if ($dr -and @($dr.buckets).Count -eq 1) {
    $bk = @($dr.buckets)[0]; $row = $bk.models.'claude-test'
    $okA = ($bk.tool -ceq 'claude') -and ($bk.sessionId -ceq 'smoke-sess') -and ($bk.turns -eq 1) -and ($row.requests -eq 1) -and ($row.outputTokens -eq 4) -and ($row.inputTokens -eq 3) -and ($row.cacheReadTokens -eq 5) -and ($row.cacheWriteTokens -eq 6)
  }
  Check 'session-report --dry-run parses the fixture transcript' (($r.Code -eq 0) -and $okA) ("exit=$($r.Code) stdout=$($r.Out) stderr=$($r.Err)")
  Put $tr ((($u1, $u2, $a1, $a2) -join "`n") + "`n")
  $r = RunCli @('session-report', '--dry-run', '--sweep')
  $dr = $null
  try { $dr = $r.Out | ConvertFrom-Json } catch { }
  $okB = $false
  if ($dr -and @($dr.buckets).Count -eq 1) { $row = @($dr.buckets)[0].models.'claude-test'; $okB = ($row.requests -eq 1) -and ($row.outputTokens -eq 9) }
  Check 'session-report dedupes a repeated message id (max usage)' (($r.Code -eq 0) -and $okB) ("stdout=$($r.Out) stderr=$($r.Err)")
  Check 'session-report --dry-run saves no state' (-not (Test-Path -LiteralPath (Join-Path $CfgDir 'sessions-state.json')))
  $r = Run 'cmd.exe' @('/d', '/s', '/c', "`"$hookCmd`"")
  Check 'Stop hook command exits 0 without a Cognito session' ($r.Code -eq 0) ("exit=$($r.Code) stderr=$($r.Err)")
  Check 'Stop hook command writes nothing to stdout' (-not $r.Out) $r.Out

  # 5. idempotent
  $before = (Text $CodexFile) + (Text $SettingsFile) + (Text $AwsConfig)
  $r = RunCli @('setup')
  $after = (Text $CodexFile) + (Text $SettingsFile) + (Text $AwsConfig)
  Check 'second setup changes nothing' (($r.Code -eq 0) -and ($before -ceq $after))

  # 5b. keep-alive: scheduled task + Startup entry + Start menu sign-in, all hidden launchers
  $task = $null
  try { $task = Get-ScheduledTask -TaskName $KaName -ErrorAction Stop } catch { }
  Check 'setup registers the keep-alive task' ($null -ne $task)
  if ($task) {
    $act = @($task.Actions)[0]
    Check 'keep-alive task runs wscript (no console window)' ($act.Execute -eq 'wscript.exe') "$($act.Execute) $($act.Arguments)"
    Check 'keep-alive task repeats every 30 min' ((@($task.Triggers)[0].Repetition.Interval) -eq 'PT30M') (@($task.Triggers)[0].Repetition.Interval)
  }
  Check 'setup adds the Startup entry' (Test-Path -LiteralPath $KaStartup) $KaStartup
  Check 'setup adds the Start menu sign-in entry' (Test-Path -LiteralPath $KaShortcut) $KaShortcut
  $vbs = Join-Path $Bin "cc-bedrock-keepalive.vbs"
  Check 'keep-alive launcher points at this CLI' ((Text $vbs).Contains($CliCopy) -and (Text $vbs).Contains(' keepalive", 0, True')) (Text $vbs)
  # keepalive with fresh credentials (2099) does nothing and exits 0, no network
  $r = RunCli @('keepalive')
  Check 'keepalive with fresh credentials exits 0' ($r.Code -eq 0) ("exit=$($r.Code) stderr=$($r.Err)")

  # 6. credential-process exactly as the AWS SDK runs it (cmd.exe /C <command>)
  $want = '{"Version":1,"AccessKeyId":"AKIA","SecretAccessKey":"SECRET","SessionToken":"TOKEN","Expiration":"2099-01-01T00:00:00Z"}'
  $r = Run 'cmd.exe' @('/d', '/s', '/c', "`"$cmd`"")
  Check 'credential-process via cmd.exe: exit 0' ($r.Code -eq 0) $r.Err
  Check 'credential-process via cmd.exe: one JSON line on stdout' ($r.Out.TrimEnd("`r", "`n") -ceq $want) ("stdout=[$($r.Out)]")
  # A cache hit must stay far inside SDK credential load timeouts (Codex: a few seconds).
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $r = Run 'cmd.exe' @('/d', '/s', '/c', "`"$cmd`"")
  $sw.Stop()
  Check 'credential-process cache hit under 5 s' (($r.Code -eq 0) -and $sw.Elapsed.TotalSeconds -lt 5) ("{0:N2} s" -f $sw.Elapsed.TotalSeconds)

  # 7. AWS CLI reads the profile (what Claude Desktop Cowork/Chat relies on)
  if (Get-Command aws -ErrorAction SilentlyContinue) {
    $env:AWS_CONFIG_FILE = $AwsConfig
    $env:AWS_SHARED_CREDENTIALS_FILE = Join-Path $H '.aws\credentials'
    $r = Run 'aws' @('configure', 'export-credentials', '--profile', 'cc-bedrock', '--format', 'process')
    Check 'aws configure export-credentials --profile cc-bedrock' (($r.Code -eq 0) -and $r.Out.Contains('"AKIA"')) ("exit=$($r.Code) $($r.Err)")
    $env:AWS_CONFIG_FILE = $null; $env:AWS_SHARED_CREDENTIALS_FILE = $null
  } else {
    [Console]::WriteLine('SKIP  aws CLI not installed (needed only for Claude Desktop Cowork/Chat)')
  }

  # 8. ACL: inheritance removed, current user has full control
  $acl = (& icacls.exe $CfgDir) -join "`n"
  $me = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  Check 'config dir ACL: only the owner (no inherited ACEs)' (($acl -notmatch '\(I\)') -and ($acl.Contains($me))) $acl
  $sids = @((Get-Acl -LiteralPath $CfgDir).Access | ForEach-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value })
  Check 'config dir ACL: earlier explicit Users grant removed' (-not ($sids -contains 'S-1-5-32-545')) ($sids -join ', ')
  $r = RunCli @('setup')
  Check 'setup reports the applied Codex provider (mantle default here)' ($r.Out -cmatch 'codex  -> Bedrock \(.*: amazon-bedrock, ') $r.Out
  Check 'setup tells Windows users Codex has no read-deny' ($r.Out.Contains('Windows: Codex gets no read-deny')) $r.Out

  # 9. set-model
  $r = RunCli @('set-model', 'opus=global.anthropic.claude-opus-5')
  $s = (Text $SettingsFile) | ConvertFrom-Json
  Check 'set-model updates config + settings.json' (($r.Code -eq 0) -and ((Text (Join-Path $CfgDir 'config')) -cmatch '(?m)^ANTHROPIC_DEFAULT_OPUS_MODEL=global\.anthropic\.claude-opus-5$') -and ($s.env.ANTHROPIC_DEFAULT_OPUS_MODEL -eq 'global.anthropic.claude-opus-5'))

  # 10. status / config / models run without error
  foreach ($sub in @('status', 'config', 'models', 'help')) {
    $r = RunCli @($sub)
    Check "$sub exits 0" ($r.Code -eq 0) $r.Err
  }

  # 11. unsetup restores user settings
  $r = RunCli @('unsetup')
  Check 'unsetup exits 0' ($r.Code -eq 0) $r.Err
  $s = ((Text $SettingsFile) | ConvertFrom-Json | ConvertTo-Json -Depth 10 -Compress)
  Check 'unsetup restores settings.json' ($s -ceq $OrigSettings) $s
  Check 'unsetup removes the Stop hook' (-not $s.Contains('session-report')) $s
  $t = Text $CodexFile
  Check 'unsetup removes managed Codex keys' (($t -notmatch 'cc-bedrock') -and ($t -cmatch '(?m)^\[profiles\.work\]')) $t
  Check 'unsetup removes mantle.config.toml' (-not (Test-Path -LiteralPath $MantleFile))
  Check 'unsetup removes runtime.config.toml' (-not (Test-Path -LiteralPath $RuntimeFile))
  $task = $null
  try { $task = Get-ScheduledTask -TaskName $KaName -ErrorAction Stop } catch { }
  Check 'unsetup removes the keep-alive task' ($null -eq $task)
  Check 'unsetup removes the Startup and Start menu entries' ((-not (Test-Path -LiteralPath $KaStartup)) -and (-not (Test-Path -LiteralPath $KaShortcut)))
}
finally {
  if (Get-Variable -Name KaName -ErrorAction SilentlyContinue) {
    try { Unregister-ScheduledTask -TaskName $KaName -Confirm:$false -ErrorAction Stop } catch { }
    Remove-Item -LiteralPath $KaStartup, $KaShortcut -Force -ErrorAction SilentlyContinue
  }
  foreach ($n in $EnvNames) { [Environment]::SetEnvironmentVariable($n, $Saved[$n], 'Process') }
  if ($Keep -or $script:Failed) { [Console]::WriteLine(''); [Console]::WriteLine("kept: $Root") }
  else { Remove-Item -LiteralPath $Root -Recurse -Force -ErrorAction SilentlyContinue }
}

[Console]::WriteLine('')
[Console]::WriteLine("$($script:Passed) passed, $($script:Failed) failed")
if ($script:Failed) { exit 1 }
exit 0
