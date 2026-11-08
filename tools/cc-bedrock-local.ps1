# cc-bedrock-local.ps1 - Local Governance Mode CLI for Windows (ADR-006, ADR-014)
#
# Windows port of tools/cc-bedrock-local.sh. Same config/state files, same
# Cognito -> /api/local/credentials -> STS flow, same managed keys in Claude Code
# and Codex config, so plain CLIs and the desktop apps on a Windows PC use the
# per-user Bedrock role (metering, budget deny) without bash, python or WSL.
#
# Covered clients:
#   Claude Code CLI + Claude Desktop "Code" tab  ~\.claude\settings.json (env + awsCredentialExport)
#   Codex CLI + Codex desktop app                ~\.codex\config.toml (amazon-bedrock-runtime provider)
#   Claude Desktop Cowork/Chat (opt-in)          HKCU\SOFTWARE\Policies\Claude third-party mode
#                                                (named AWS profile; needs AWS CLI v2) - setup-desktop
#
# Subcommands:
#   login | refresh | credential-process | logout | change-email | status
#   setup | unsetup | setup-desktop | unsetup-desktop | set-model K=V | models | config | help
#   session-report [--sweep] [--quiet]  per-session turn/token totals of local Claude Code
#                transcripts + Codex rollouts -> dashboard (insight only; Stop hook)
#
# Requires Windows PowerShell 5.1 or PowerShell 7. Nothing else.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Set-StrictMode -Version 2.0
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch { }

$OnWindows = ($env:OS -eq 'Windows_NT')
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

$HomeDir = if ($env:USERPROFILE -and $OnWindows) { $env:USERPROFILE } else { $HOME }
function Join-Full([string]$base, [string]$rel) { return [IO.Path]::GetFullPath((Join-Path $base $rel)) }
$CfgDir = Join-Full $HomeDir '.config/cc-bedrock'
$CfgFile = Join-Path $CfgDir 'config'
$StateFile = Join-Path $CfgDir 'state.json'
$TokenCache = Join-Path $CfgDir 'cognito-tokens.json'
$AwsCredsFile = Join-Full $HomeDir '.aws/credentials'
$AwsConfigFile = Join-Full $HomeDir '.aws/config'
$ClaudeDir = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $HomeDir '.claude' }
$ClaudeSettingsFile = Join-Path $ClaudeDir 'settings.json'
$CodexDir = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HomeDir '.codex' }
$CodexConfigFile = Join-Path $CodexDir 'config.toml'
$DesktopPolicyKey = 'HKCU:\SOFTWARE\Policies\Claude'
$DesktopRegFile = Join-Path $CfgDir 'claude-desktop-bedrock.reg'
$SessionsStateFile = Join-Path $CfgDir 'sessions-state.json'
$SessionLogFile = Join-Path $CfgDir 'session-report.log'

# --- output (stdout is reserved for credential-process JSON) -
function Say([string]$msg) { [Console]::Error.WriteLine("cc-bedrock-local: $msg") }
function Out([string]$msg) { [Console]::Out.WriteLine($msg) }
function Die([string]$msg) { Say $msg; exit 1 }

# --- files --------------------------------------------------
function Write-TextFile([string]$path, [string]$text) {
  $dir = Split-Path -Parent $path
  if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  # Unique temp name: Claude and Codex may run credential-process concurrently.
  $tmp = "$path.$PID.tmp"
  [IO.File]::WriteAllText($tmp, $text, $Utf8NoBom)
  # The rename would give the file the temp file's inherited ACL; keep the
  # original one (an owner-only file must stay owner-only). Best effort: files
  # holding secrets are also passed through Protect-Path, which fails closed.
  if ($OnWindows -and (Test-Path -LiteralPath $path)) {
    try { Set-Acl -LiteralPath $tmp -AclObject (Get-Acl -LiteralPath $path) } catch { }
  }
  # Windows refuses to replace a file another process has open (a concurrent
  # credential-process reading state.json); retry briefly instead of failing.
  for ($try = 1; ; $try++) {
    try { Move-Item -LiteralPath $tmp -Destination $path -Force -ErrorAction Stop; break }
    catch {
      if ($try -ge 10) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue; throw }
      Start-Sleep -Milliseconds 100
    }
  }
}

function Read-TextFile([string]$path) {
  if (Test-Path -LiteralPath $path) { return [IO.File]::ReadAllText($path) }
  return ''
}

# Owner-only access: Windows ACL (inheritable on the directory) or chmod elsewhere.
# $soft: throw instead of Die (session-report must never exit non-zero from a hook).
function Protect-Path([string]$path, [bool]$soft = $false) {
  if (-not (Test-Path -LiteralPath $path)) { return }
  if ($OnWindows) {
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $isDir = (Get-Item -LiteralPath $path) -is [IO.DirectoryInfo]
    $grant = if ($isDir) { "*${sid}:(OI)(CI)F" } else { "*${sid}:F" }
    # Reset first: /inheritance:r alone keeps explicit ACEs someone added earlier.
    # A directory's children are reset too, so they inherit the owner-only ACE.
    $reset = if ($isDir) { @('/reset', '/T', '/C', '/Q') } else { @('/reset', '/Q') }
    $o = & icacls.exe $path @reset 2>&1
    if ($LASTEXITCODE -eq 0) { $o = & icacls.exe $path /inheritance:r /grant:r $grant 2>&1 }
    # Fail closed: the directory holds the refresh token and STS keys.
    if ($LASTEXITCODE -ne 0) {
      $msg = "could not restrict access to $path (icacls: $(($o | Out-String).Trim()))"
      if ($soft) { throw $msg }
      Die $msg
    }
  } else {
    $mode = if ((Get-Item -LiteralPath $path) -is [IO.DirectoryInfo]) { '700' } else { '600' }
    & chmod $mode $path 2>&1 | Out-Null
  }
}

function Backup-Once([string]$path) {
  if ((Test-Path -LiteralPath $path) -and -not (Test-Path -LiteralPath "$path.cc-bedrock.bak")) {
    Copy-Item -LiteralPath $path -Destination "$path.cc-bedrock.bak"
  }
}

if (-not (Test-Path -LiteralPath $CfgDir)) {
  New-Item -ItemType Directory -Force -Path $CfgDir | Out-Null
  Protect-Path $CfgDir
}

# --- JSON (PS 5.1 has no -AsHashtable; keep key order for user files) -
function ConvertFrom-JsonText([string]$text) {
  if (-not $text.Trim()) { return $null }
  $cmd = Get-Command ConvertFrom-Json
  # PS 7 turns ISO date strings into DateTime; keep them as strings when possible.
  if ($cmd.Parameters.ContainsKey('DateKind')) { return ConvertTo-Plain ($text | ConvertFrom-Json -DateKind String) }
  return ConvertTo-Plain ($text | ConvertFrom-Json)
}

function ConvertTo-Plain($o) {
  if ($null -eq $o) { return $null }
  if ($o.GetType().FullName -eq 'System.Management.Automation.PSCustomObject') {
    $h = [ordered]@{}
    foreach ($p in $o.PSObject.Properties) { $h[$p.Name] = ConvertTo-Plain $p.Value }
    return $h
  }
  if ($o -is [Collections.IList]) {
    $l = New-Object Collections.ArrayList
    foreach ($i in $o) { [void]$l.Add((ConvertTo-Plain $i)) }
    return , $l
  }
  return $o
}

function ConvertTo-JsonText($o) { return ($o | ConvertTo-Json -Depth 32) }

function Format-Iso($v) {
  # Invariant culture: a culture whose time separator is not ':' would corrupt Expiration.
  if ($v -is [datetime]) { return $v.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ', [Globalization.CultureInfo]::InvariantCulture) }
  return [string]$v
}

function ConvertTo-Epoch([string]$iso) {
  try {
    return [DateTimeOffset]::Parse($iso, [Globalization.CultureInfo]::InvariantCulture).ToUnixTimeSeconds()
  } catch { return 0 }
}

function Get-EpochNow { return [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() }

# --- config (KEY=VALUE, same file as the bash CLI) ----------
$Config = [ordered]@{}
foreach ($line in ((Read-TextFile $CfgFile) -split "`r?`n")) {
  $t = $line.Trim()
  if (-not $t -or $t.StartsWith('#') -or -not $t.Contains('=')) { continue }
  $k, $v = $t.Split('=', 2)
  $v = $v.Trim()
  if ($v.Length -ge 2 -and (($v[0] -eq '"' -and $v[-1] -eq '"') -or ($v[0] -eq "'" -and $v[-1] -eq "'"))) { $v = $v.Substring(1, $v.Length - 2) }
  $Config[$k.Trim()] = $v
}
# Config file first, then the environment (the bash CLI sources the file over
# the environment, so a stray AWS_REGION in the user's env doesn't win either).
function Cfg([string]$key, [string]$default = '') {
  if ($Config.Contains($key) -and $Config[$key]) { return $Config[$key] }
  $envVal = [Environment]::GetEnvironmentVariable($key)
  if ($envVal) { return $envVal }
  return $default
}

$DashboardUrl = if ($env:CC_BEDROCK_DASHBOARD_URL) { $env:CC_BEDROCK_DASHBOARD_URL } else { Cfg 'DASHBOARD_URL' }
$CognitoRegion = Cfg 'COGNITO_REGION' 'ap-northeast-2'
$CognitoClientId = Cfg 'COGNITO_CLIENT_ID'
$Email = if ($env:CC_BEDROCK_EMAIL) { $env:CC_BEDROCK_EMAIL } else { Cfg 'EMAIL' }
$AwsProfileName = Cfg 'AWS_PROFILE_NAME' 'cc-bedrock'
$AwsRegion = Cfg 'AWS_REGION' 'ap-northeast-2'

# Model env - Bedrock inference profile IDs mapped to Claude Code's model slots
# (defaults match the bash CLI; ANTHROPIC_MODEL=opusplan backs /model "Default").
$Models = [ordered]@{
  # 'set-model pin=' writes an empty ANTHROPIC_MODEL= to unset it: only an absent key
  # defaults (same as the bash CLI's ${ANTHROPIC_MODEL-opusplan}).
  ANTHROPIC_MODEL                = if ($Config.Contains('ANTHROPIC_MODEL')) { [string]$Config['ANTHROPIC_MODEL'] } else { Cfg 'ANTHROPIC_MODEL' 'opusplan' }
  ANTHROPIC_DEFAULT_SONNET_MODEL = Cfg 'ANTHROPIC_DEFAULT_SONNET_MODEL' 'global.anthropic.claude-sonnet-5-5'
  ANTHROPIC_DEFAULT_OPUS_MODEL   = Cfg 'ANTHROPIC_DEFAULT_OPUS_MODEL' 'global.anthropic.claude-opus-5-5'
  ANTHROPIC_DEFAULT_HAIKU_MODEL  = Cfg 'ANTHROPIC_DEFAULT_HAIKU_MODEL' (Cfg 'ANTHROPIC_SMALL_FAST_MODEL' 'global.anthropic.claude-haiku-5-5')
  CLAUDE_CODE_SUBAGENT_MODEL     = Cfg 'CLAUDE_CODE_SUBAGENT_MODEL' 'global.anthropic.claude-sonnet-5-5'
  CODEX_MODEL                    = Cfg 'CODEX_MODEL' 'global.openai.gpt-6.1-sol'
}
# Session insights (session-report + the Claude Code Stop hook); 'off' disables both.
$SessionReport = Cfg 'SESSION_REPORT' 'on'
function Test-SessionReportEnabled { return -not (@('off', 'OFF', 'Off') -ccontains $SessionReport) }

function Require-Config {
  if (-not $DashboardUrl) { Die "DASHBOARD_URL not set (edit $CfgFile)" }
  if (-not $CognitoClientId) { Die "COGNITO_CLIENT_ID not set (edit $CfgFile)" }
}

function Set-ConfigValue([string]$key, [string]$val) {
  $content = Read-TextFile $CfgFile
  $pattern = "(?m)^$([regex]::Escape($key))=.*$"
  if ([regex]::IsMatch($content, $pattern)) {
    $content = [regex]::Replace($content, $pattern, { param($m) "$key=$val" })
  } else {
    $content = $content.TrimEnd() + "`n$key=$val`n"
  }
  Write-TextFile $CfgFile $content
  Protect-Path $CfgFile
}

# --- HTTP (HttpClient: exact Content-Type, error bodies kept) -
function Invoke-Post([string]$uri, [string]$body, [string]$contentType, [hashtable]$headers = @{}, [int]$timeoutSec = 30) {
  if ($PSVersionTable.PSVersion.Major -lt 6) { Add-Type -AssemblyName System.Net.Http }
  $client = New-Object System.Net.Http.HttpClient
  $client.Timeout = [TimeSpan]::FromSeconds($timeoutSec)
  try {
    $req = New-Object System.Net.Http.HttpRequestMessage([System.Net.Http.HttpMethod]::Post, $uri)
    foreach ($k in $headers.Keys) { [void]$req.Headers.TryAddWithoutValidation($k, [string]$headers[$k]) }
    $req.Content = New-Object System.Net.Http.StringContent($body, $Utf8NoBom)
    $req.Content.Headers.ContentType = [System.Net.Http.Headers.MediaTypeHeaderValue]::Parse($contentType)
    $resp = $client.SendAsync($req).GetAwaiter().GetResult()
    return @{ Status = [int]$resp.StatusCode; Body = $resp.Content.ReadAsStringAsync().GetAwaiter().GetResult() }
  } finally {
    $client.Dispose()
  }
}

function Invoke-Cognito([hashtable]$authParams, [string]$flow) {
  $body = ConvertTo-JsonText ([ordered]@{ AuthFlow = $flow; ClientId = $CognitoClientId; AuthParameters = $authParams })
  $r = Invoke-Post "https://cognito-idp.$CognitoRegion.amazonaws.com/" $body 'application/x-amz-json-1.1' @{ 'X-Amz-Target' = 'AWSCognitoIdentityProviderService.InitiateAuth' }
  $d = $null
  try { $d = ConvertFrom-JsonText $r.Body } catch { }
  if ($d -and $d.Contains('AuthenticationResult') -and $d['AuthenticationResult']) { return $d['AuthenticationResult'] }
  $err = 'unknown error'
  if ($d -and $d.Contains('message')) { $err = $d['message'] } elseif ($d -and $d.Contains('__type')) { $err = $d['__type'] } elseif ($r.Body) { $err = "HTTP $($r.Status)" }
  throw "cognito error: $err"
}

# exp claim of a Cognito JWT (fallback: 1h from now, Cognito's default lifetime).
function Get-JwtExp([string]$tok) {
  try {
    $p = $tok.Split('.')[1].Replace('-', '+').Replace('_', '/')
    switch ($p.Length % 4) { 2 { $p += '==' } 3 { $p += '=' } }
    $c = ConvertFrom-JsonText ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($p)))
    if ($c -and $c.Contains('exp')) { return [long]$c['exp'] }
  } catch { }
  return (Get-EpochNow) + 3600
}

# accessExpiresAt lets session-report reuse the access token until < 5 min remain.
# Protect-Path (two icacls runs) only for a new file: Write-TextFile keeps an existing
# file's owner-only ACL, and credential-process must stay fast (SDK load timeouts).
function Save-Tokens([string]$access, [string]$refresh) {
  $new = -not (Test-Path -LiteralPath $TokenCache)
  $json = ConvertTo-JsonText ([ordered]@{ accessToken = $access; accessExpiresAt = (Get-JwtExp $access); refreshToken = $refresh; obtainedAt = (Get-EpochNow) })
  Write-TextFile $TokenCache $json
  if ($new) { Protect-Path $TokenCache }
}

function Get-CachedRefreshToken {
  if (-not (Test-Path -LiteralPath $TokenCache)) { return '' }
  try {
    $t = ConvertFrom-JsonText (Read-TextFile $TokenCache)
    if ($t -and $t.Contains('refreshToken') -and $t['refreshToken']) { return [string]$t['refreshToken'] }
  } catch { }
  return ''
}

# Silent Cognito refresh from the cached refresh token, re-cached. Uses
# GetTokensFromRefreshToken, not InitiateAuth REFRESH_TOKEN_AUTH: it works with and
# without refresh-token rotation (Terraform cli_refresh_token_rotation), and with
# rotation the response carries a new RefreshToken that replaces the cached one.
# Returns @{ Kind = 'ok' | 'dead' | 'transient'; Access; Message }: 'dead' needs a
# new sign-in (expired/revoked), 'transient' (network, Cognito outage) a retry.
function Invoke-CognitoRefresh {
  $refresh = Get-CachedRefreshToken
  if (-not $refresh) { return @{ Kind = 'dead'; Access = ''; Message = "no cached session - run 'cc-bedrock-local login'" } }
  $body = ConvertTo-JsonText ([ordered]@{ ClientId = $CognitoClientId; RefreshToken = $refresh })
  try {
    $r = Invoke-Post "https://cognito-idp.$CognitoRegion.amazonaws.com/" $body 'application/x-amz-json-1.1' @{ 'X-Amz-Target' = 'AWSCognitoIdentityProviderService.GetTokensFromRefreshToken' } 15
  } catch {
    return @{ Kind = 'transient'; Access = ''; Message = "could not reach Cognito ($($_.Exception.Message)) - check the network and retry" }
  }
  $d = $null
  try { $d = ConvertFrom-JsonText $r.Body } catch { }
  if ($d -and $d.Contains('AuthenticationResult') -and $d['AuthenticationResult'] -and $d['AuthenticationResult']['AccessToken']) {
    $a = $d['AuthenticationResult']
    $next = $refresh
    if ($a.Contains('RefreshToken') -and $a['RefreshToken']) { $next = [string]$a['RefreshToken'] }
    Save-Tokens ([string]$a['AccessToken']) $next
    return @{ Kind = 'ok'; Access = [string]$a['AccessToken']; Message = '' }
  }
  $type = ''
  if ($d -and $d.Contains('__type')) { $type = ([string]$d['__type']).Split('#')[-1] }
  $msg = "HTTP $($r.Status)"
  if ($d -and $d.Contains('message') -and $d['message']) { $msg = [string]$d['message'] } elseif ($type) { $msg = $type }
  if (@('NotAuthorizedException', 'RefreshTokenReuseException', 'UserNotFoundException') -ccontains $type) {
    return @{ Kind = 'dead'; Access = ''; Message = "sign-in expired or revoked ($msg) - run 'cc-bedrock-local login'" }
  }
  return @{ Kind = 'transient'; Access = ''; Message = "Cognito refresh failed ($msg) - retry later" }
}

# One refresher at a time: Claude Code, Codex, the Stop hook and the keep-alive task
# can all find the credentials expired at once (after sleep or a reboot). A waiter
# re-checks the cache the winner wrote. Past 25 s it proceeds unlocked. A process
# that exits while holding the mutex abandons it, which the next waiter acquires.
function Enter-RefreshLock {
  try {
    $m = New-Object Threading.Mutex($false, 'Local\cc-bedrock-refresh')
    try { [void]$m.WaitOne(25000) } catch [Threading.AbandonedMutexException] { }
    return $m
  } catch { return $null }
}

function Exit-RefreshLock($m) {
  if (-not $m) { return }
  try { $m.ReleaseMutex() } catch { }
  $m.Dispose()
}

function Test-StateFresh($state, [long]$minSeconds = 300) {
  return [bool]($state -and $state.Contains('credentials') -and ((Get-StateExpiryEpoch $state) - (Get-EpochNow) -gt $minSeconds))
}

# Exchange a Cognito access token for STS credentials via the dashboard.
# Returns the raw response text when it carries credentials, else $null.
function Request-Sts([string]$accessToken) {
  $r = Invoke-Post ($DashboardUrl.TrimEnd('/') + '/api/local/credentials') '{}' 'application/json' @{ Authorization = "Bearer $accessToken" }
  try {
    $d = ConvertFrom-JsonText $r.Body
    if ($d -and $d.Contains('credentials')) { return $r.Body }
  } catch { }
  [Console]::Error.WriteLine($r.Body)
  return $null
}

function Read-State {
  if (-not (Test-Path -LiteralPath $StateFile)) { return $null }
  try { return ConvertFrom-JsonText (Read-TextFile $StateFile) } catch { return $null }
}

function Save-State([string]$raw) {
  $new = -not (Test-Path -LiteralPath $StateFile)
  Write-TextFile $StateFile $raw
  if ($new) { Protect-Path $StateFile }
}

# Pass the state you will emit, so the expiry check and the emitted credentials come
# from the same snapshot (a concurrent refresh may rewrite state.json in between).
function Get-StateExpiryEpoch($s = (Read-State)) {
  if (-not $s -or -not $s.Contains('credentials')) { return 0 }
  return ConvertTo-Epoch (Format-Iso $s['credentials']['expiration'])
}

# --- credential command line --------------------------------
# Run by the AWS SDK (cmd.exe /C on Windows) and by Claude Code's
# awsCredentialExport. Forward slashes keep it valid in cmd, Git Bash and
# PowerShell alike. No double quotes (cmd.exe /C from the Rust SDK passes them to
# PowerShell literally); a path with whitespace uses -EncodedCommand instead.
function Get-SelfPath {
  $p = $PSCommandPath
  if ($OnWindows) { $p = $p -replace '\\', '/' }
  return $p
}
# Windows: no double quotes in the command. The Rust AWS SDK (Codex) runs
# credential_process as one argument to `cmd.exe /C`, which Rust escapes as \"...\";
# cmd does not undo that, so PowerShell would get -File with literal quotes and fail
# ("failed to load AWS credentials"). A path without whitespace needs no quotes; one
# with whitespace or a cmd metacharacter (& ^ % ( ) !) goes through -EncodedCommand.
# Claude Code (Node shell) and the AWS CLI accept both forms.
function Get-CliCommand([string]$subArgs) {
  $self = Get-SelfPath
  $ps = 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass'
  if ($OnWindows) {
    if ($self -notmatch '[\s&^%()!"]') { return "$ps -File $self $subArgs" }
    $script = "& '" + $self.Replace("'", "''") + "' $subArgs; exit `$LASTEXITCODE"
    return "$ps -EncodedCommand " + [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($script))
  }
  return "pwsh -NoProfile -NonInteractive -File `"$self`" $subArgs"
}
function Get-CredentialCommand { return Get-CliCommand 'credential-process' }
# Claude Code Stop hook (session insights); same command forms as above.
function Get-SessionHookCommand { return Get-CliCommand 'session-report --quiet' }
# Ours: any -File form (older quoted lines included) or this install's encoded form.
function Test-OurCredentialCommand([string]$v) {
  return ($v.EndsWith(' credential-process') -or ($v -ceq (Get-CredentialCommand)))
}
# Ours: any command ending in ' session-report --quiet', or an -EncodedCommand form
# (any install path) whose script runs session-report --quiet.
function Test-OurSessionHook([string]$v) {
  if ($v.EndsWith(' session-report --quiet', [StringComparison]::Ordinal) -or ($v -ceq (Get-SessionHookCommand))) { return $true }
  if ($v -cmatch '-EncodedCommand (\S+)$') {
    try { return [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($Matches[1])).Contains("' session-report --quiet; exit") } catch { }
  }
  return $false
}

# ADR-029: [profile X] gets credential_process (the SDK re-invokes us before
# Expiration); a stale static-key [X] in ~/.aws/credentials is removed because it
# would shadow credential_process.
function Install-AwsProfile {
  $created = -not (Test-Path -LiteralPath $AwsConfigFile)
  $content = Read-TextFile $AwsConfigFile
  $content = [regex]::Replace($content, "(?ms)^\[profile $([regex]::Escape($AwsProfileName))\].*?(?=^\[|\z)", '').TrimEnd() + "`n"
  if ($content -eq "`n") { $content = '' }
  $block = "`n[profile $AwsProfileName]`ncredential_process = $(Get-CredentialCommand)`nregion = $AwsRegion`n"
  Write-TextFile $AwsConfigFile ($content + $block)
  if (Test-Path -LiteralPath $AwsCredsFile) {
    $c = Read-TextFile $AwsCredsFile
    $cleaned = [regex]::Replace($c, "(?ms)^\[$([regex]::Escape($AwsProfileName))\].*?(?=^\[|\z)", '').TrimEnd() + "`n"
    if ($cleaned -ne $c) { Write-TextFile $AwsCredsFile $cleaned; Protect-Path $AwsCredsFile }
  }
  if ($created) { Protect-Path $AwsConfigFile }
}

function Complete-Sts([string]$raw) {
  Install-AwsProfile
  Save-State $raw
  $s = ConvertFrom-JsonText $raw
  Out "OK credential_process profile=$AwsProfileName installed, current creds expire=$(Format-Iso $s['credentials']['expiration']) (SDK auto-renews in-session)"
  Sync-CodexMantle
  $note = Get-MantleNote
  if ($note) { Out "! $note" }
}

# --- login / refresh / logout / change-email ----------------
function Read-Password {
  $sec = Read-Host -Prompt 'Password' -AsSecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

function Invoke-Login {
  Require-Config
  if (-not $script:Email) {
    Say "EMAIL not set in $CfgFile - use 'change-email' first"
    Invoke-ChangeEmail
    return
  }
  Out "Email: $script:Email"
  $password = Read-Password
  if (-not $password) { Die 'password is empty' }
  try {
    $auth = Invoke-Cognito @{ USERNAME = $script:Email; PASSWORD = $password } 'USER_PASSWORD_AUTH'
  } catch { Die $_.Exception.Message }
  if (-not $auth['AccessToken']) { Die 'Cognito did not return AccessToken' }
  Save-Tokens $auth['AccessToken'] $auth['RefreshToken']
  Out 'OK login OK'
  $raw = Request-Sts $auth['AccessToken']
  if (-not $raw) { Die 'dashboard refused STS issue' }
  Complete-Sts $raw
  Start-SessionSweep
}

function Invoke-Refresh {
  Require-Config
  $lock = Enter-RefreshLock
  try { $r = Invoke-CognitoRefresh } finally { Exit-RefreshLock $lock }
  if ($r.Kind -eq 'dead') { Say $r.Message; exit 2 }
  if ($r.Kind -ne 'ok') { Say $r.Message; exit 3 }
  Out 'OK silent refresh OK'
  $raw = Request-Sts $r.Access
  if (-not $raw) { Die 'dashboard refused STS issue' }
  Complete-Sts $raw
}

function Invoke-Logout {
  Remove-Item -LiteralPath $TokenCache, $StateFile -Force -ErrorAction SilentlyContinue
  Out "OK cached session cleared (run 'cc-bedrock-local login' to sign in again)"
}

function Invoke-ChangeEmail {
  Require-Config
  $new = Read-Host -Prompt 'New Cognito email'
  if (-not $new) { Die 'email is empty' }
  Set-ConfigValue 'EMAIL' $new
  $script:Email = $new
  # Refresh tokens belong to the old account.
  Remove-Item -LiteralPath $TokenCache, $StateFile -Force -ErrorAction SilentlyContinue
  Out "OK email updated to $new - re-authenticating..."
  Invoke-Login
}

# --- credential-process (AWS SDK hook, ADR-029) -------------
# Contract: ONE JSON object on stdout, diagnostics on stderr, never prompt. Exit 1
# when the Cognito refresh token is dead so the SDK surfaces a re-login error.
function Write-CredentialsJson($state) {
  $c = $state['credentials']
  $json = ([ordered]@{
      Version         = 1
      AccessKeyId     = [string]$c['accessKeyId']
      SecretAccessKey = [string]$c['secretAccessKey']
      SessionToken    = [string]$c['sessionToken']
      Expiration      = Format-Iso $c['expiration']
    } | ConvertTo-Json -Compress)
  [Console]::Out.Write($json + "`n")
}

function Invoke-CredentialProcess {
  try {
    Require-Config
    # Cache hit while > 5 min remain (the SDK refreshes ahead of Expiration).
    $state = Read-State
    if (Test-StateFresh $state) { Write-CredentialsJson $state; return }
    # Keep this path short: SDKs time out credential loading (the Codex app's Rust SDK
    # after a few seconds), so the Codex mantle sync and the session sweep run in a
    # detached process after the JSON is out.
    $lock = Enter-RefreshLock
    try {
      $state = Read-State
      if (Test-StateFresh $state) { Write-CredentialsJson $state; return }
      $r = Invoke-CognitoRefresh
      if ($r.Kind -ne 'ok') { Say $r.Message; exit 1 }
      $raw = Request-Sts $r.Access
      if (-not $raw) { Say "dashboard refused STS issue (token limit Deny active? check 'cc-bedrock-local status')"; exit 1 }
      Save-State $raw
    } finally {
      Exit-RefreshLock $lock
    }
    Write-CredentialsJson (ConvertFrom-JsonText $raw)
    Start-Detached @('post-issue')
  } catch {
    Say $_.Exception.Message
    exit 1
  }
}

# Detached follow-up of a credential-process issue (hidden, no wait, no shared stdout).
function Invoke-PostIssue {
  try { Require-Config; Sync-CodexMantle } catch { }
  Start-SessionSweep
}

# --- setup / unsetup (Claude Code + Codex, CLI and desktop) -
$ClaudeManagedEnv = @('CLAUDE_CODE_USE_BEDROCK', 'AWS_REGION', 'ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL')
$ClaudeCredRule = 'Read(~/.config/cc-bedrock/**)'
$CodexMark = '# managed by cc-bedrock-local'

function Read-ClaudeSettings {
  try { $s = ConvertFrom-JsonText (Read-TextFile $ClaudeSettingsFile) } catch { Die "$ClaudeSettingsFile is not valid JSON ($($_.Exception.Message)); fix it and re-run 'setup'" }
  if ($null -eq $s) { $s = [ordered]@{} }
  return $s
}

function Write-ClaudeSettings($s) { Write-TextFile $ClaudeSettingsFile ((ConvertTo-JsonText $s) + "`n") }

function Set-ClaudeSettings {
  Backup-Once $ClaudeSettingsFile
  $s = Read-ClaudeSettings
  if (-not $s.Contains('env') -or $null -eq $s['env']) { $s['env'] = [ordered]@{} }
  $vals = @{ CLAUDE_CODE_USE_BEDROCK = '1'; AWS_REGION = $AwsRegion }
  foreach ($k in $Models.Keys) { $vals[$k] = $Models[$k] }
  foreach ($k in $ClaudeManagedEnv) {
    if ($vals[$k]) { $s['env'][$k] = $vals[$k] } elseif ($s['env'].Contains($k)) { $s['env'].Remove($k) }
  }
  $s['awsCredentialExport'] = Get-CredentialCommand
  # Claude's Read tool must not open the cached refresh token / STS keys.
  if (-not $s.Contains('permissions') -or $null -eq $s['permissions']) { $s['permissions'] = [ordered]@{} }
  if (-not $s['permissions'].Contains('deny') -or $null -eq $s['permissions']['deny']) { $s['permissions']['deny'] = New-Object Collections.ArrayList }
  if (-not ($s['permissions']['deny'] -contains $ClaudeCredRule)) { [void]$s['permissions']['deny'].Add($ClaudeCredRule) }
  $hookCmd = ''
  if (Test-SessionReportEnabled) { $hookCmd = Get-SessionHookCommand }
  Sync-StopHook $s $hookCmd
  Write-ClaudeSettings $s
}

# Session-report Stop hook in settings.json (same edit as sync_stop_hook in the bash
# CLI): ours is updated in place or appended as its own group; an empty $cmd removes
# ours (unsetup, SESSION_REPORT=off). The user's hooks and groups are never touched,
# and only containers our removal emptied are dropped.
function Sync-StopHook($s, [string]$cmd) {
  if (-not $s.Contains('hooks') -or $null -eq $s['hooks']) {
    if (-not $cmd) { return }
    $s['hooks'] = [ordered]@{}
  }
  $hooks = $s['hooks']
  if (-not ($hooks -is [Collections.IDictionary])) { Say "$ClaudeSettingsFile 'hooks' is not an object; Stop hook left alone"; return }
  if (-not $hooks.Contains('Stop') -or $null -eq $hooks['Stop']) {
    if (-not $cmd) { return }
    $hooks['Stop'] = New-Object Collections.ArrayList
  }
  $stop = $hooks['Stop']
  if (-not ($stop -is [Collections.IList])) { Say "$ClaudeSettingsFile hooks.Stop is not a list; Stop hook left alone"; return }
  $placed = $false; $removed = $false
  foreach ($g in @($stop)) {
    if (-not ($g -is [Collections.IDictionary]) -or -not $g.Contains('hooks') -or -not ($g['hooks'] -is [Collections.IList])) { continue }
    $hs = $g['hooks']
    $before = $hs.Count
    foreach ($hk in @($hs)) {
      if (-not ($hk -is [Collections.IDictionary]) -or -not $hk.Contains('command') -or -not (Test-OurSessionHook ([string]$hk['command']))) { continue }
      if ($cmd -and -not $placed) {
        $hk['type'] = 'command'; $hk['command'] = $cmd; $hk['timeout'] = 30
        $placed = $true
      } else {
        $hs.Remove($hk); $removed = $true
      }
    }
    if ($hs.Count -eq 0 -and $before -gt 0) { $stop.Remove($g) }
  }
  if ($cmd -and -not $placed) {
    $list = New-Object Collections.ArrayList
    [void]$list.Add([ordered]@{ type = 'command'; command = $cmd; timeout = 30 })
    [void]$stop.Add([ordered]@{ hooks = $list })
  }
  if ($stop.Count -eq 0 -and $removed) {
    $hooks.Remove('Stop')
    if ($hooks.Count -eq 0) { $s.Remove('hooks') }
  }
}

function Remove-ClaudeSettings {
  if (-not (Test-Path -LiteralPath $ClaudeSettingsFile)) { return }
  $s = Read-ClaudeSettings
  if ($s.Contains('env') -and $s['env']) {
    foreach ($k in $ClaudeManagedEnv) { if ($s['env'].Contains($k)) { $s['env'].Remove($k) } }
    if ($s['env'].Count -eq 0) { $s.Remove('env') }
  }
  if ($s.Contains('awsCredentialExport') -and (Test-OurCredentialCommand ([string]$s['awsCredentialExport']))) { $s.Remove('awsCredentialExport') }
  if ($s.Contains('permissions') -and $s['permissions'] -and $s['permissions'].Contains('deny') -and $s['permissions']['deny']) {
    $deny = $s['permissions']['deny']
    while ($deny -contains $ClaudeCredRule) { $deny.Remove($ClaudeCredRule) }
    if ($deny.Count -eq 0) { $s['permissions'].Remove('deny') }
    if ($s['permissions'].Count -eq 0) { $s.Remove('permissions') }
  }
  Sync-StopHook $s ''
  Write-ClaudeSettings $s
}

function Test-ClientsConfigured {
  if (-not (Test-Path -LiteralPath $ClaudeSettingsFile)) { return $false }
  try {
    $s = ConvertFrom-JsonText (Read-TextFile $ClaudeSettingsFile)
    return [bool]($s -and $s.Contains('awsCredentialExport') -and (Test-OurCredentialCommand ([string]$s['awsCredentialExport'])))
  } catch { return $false }
}

# Table header with quoted segments and spacing normalized, so
# [model_providers."amazon-bedrock".aws] matches [model_providers.amazon-bedrock.aws]
# (bash: hdr). Non-header lines come back comment-stripped and trimmed.
function Get-TomlHeader([string]$line) {
  $h = $line.Split('#')[0].Trim()
  if ($h.StartsWith('[') -and $h.EndsWith(']')) {
    $inner = $h.TrimStart('[').TrimEnd(']').Replace('"', '').Replace("'", '')
    $inner = [regex]::Replace($inner, '\s*\.\s*', '.').Trim()
    $h = '[' + $inner + ']'
    if ($line.Split('#')[0].Trim().StartsWith('[[')) { $h = '[' + $h + ']' }
  }
  return $h
}

function ConvertTo-TomlString([string]$v) { return '"' + $v.Replace('\', '\\').Replace('"', '\"') + '"' }

# Same edit as configure_codex in cc-bedrock-local.sh: strip what we manage (and
# unmarked duplicates of those top-level keys), then add ours. Codex CLI and the
# Codex desktop app both read this file; the mantle profile file is CLI-only
# (`codex -p mantle`), the app has no profile selection.
function Set-CodexConfig([string]$mode, [bool]$quiet = $false) {
  if ($mode -ne 'add' -and -not (Test-Path -LiteralPath $CodexConfigFile)) { return }
  Backup-Once $CodexConfigFile
  $table = '[model_providers.amazon-bedrock-runtime.aws]'
  $perms = '[permissions.cc-bedrock]'
  $permsFs = '[permissions.cc-bedrock.filesystem]'
  $mProfile = '[profiles.mantle]'
  $mAws = '[model_providers.amazon-bedrock.aws]'
  $mHdr = '[model_providers.amazon-bedrock.http_headers]'
  $mPath = Join-Path (Split-Path -Parent $CodexConfigFile) 'mantle.config.toml'
  $rPath = Join-Path (Split-Path -Parent $CodexConfigFile) 'runtime.config.toml'
  $mantle = @{}
  $st = Read-State
  if ($st -and $st.Contains('mantle') -and $st['mantle']) { $mantle = $st['mantle'] }
  $mOurs = (-not (Test-Path -LiteralPath $mPath)) -or (Read-TextFile $mPath).Contains($CodexMark)
  $rOurs = (-not (Test-Path -LiteralPath $rPath)) -or (Read-TextFile $rPath).Contains($CodexMark)
  $wantMantle = ($mode -eq 'add') -and $mantle.Contains('enabled') -and $mantle['enabled'] -and $mantle.Contains('projectId') -and $mantle['projectId']

  $lines = New-Object Collections.Generic.List[string]
  $text = Read-TextFile $CodexConfigFile
  if ($text) {
    $lines.AddRange([string[]]($text -split "`r?`n"))
    if ($lines[$lines.Count - 1] -eq '') { $lines.RemoveAt($lines.Count - 1) }
  }
  # ADR-014 section 9 (amended 2026-11-03): with a mantle grant, bedrock-mantle is the
  # default provider (plain codex + the Codex app get web search); the metered runtime
  # path is 'codex -p runtime'. Ownership of the amazon-bedrock provider is decided for
  # the provider as a whole: marked tables are ours; unmarked ones are the user's and
  # are never touched, except while a grant is present and every unmarked
  # amazon-bedrock table is the aws or headers table holding only keys we manage
  # (aws: profile/region; headers: OpenAI-Project), e.g. a leftover manual
  # region = "us-east-1"; then they are replaced. Otherwise the user's provider stays
  # whole and keeps runtime the default (a second table is invalid TOML).
  # Ordinal (case-sensitive) like TOML and the bash CLI.
  $mKeys = New-Object Collections.Hashtable ([StringComparer]::Ordinal)
  $mKeys[$mAws] = @('profile', 'region'); $mKeys[$mHdr] = @('OpenAI-Project')
  $mOursAt = @{}
  $unmarked = New-Object Collections.Generic.List[int]
  $allManaged = $true
  for ($i = 0; $i -lt $lines.Count; $i++) {
    $h = Get-TomlHeader $lines[$i]
    if (-not ($h -ceq '[model_providers.amazon-bedrock]' -or $h.StartsWith('[model_providers.amazon-bedrock.', [StringComparison]::Ordinal))) { continue }
    if ($lines[$i].Contains($CodexMark)) { $mOursAt[$i] = $true; continue }
    $unmarked.Add($i)
    if (-not $mKeys.ContainsKey($h)) { $allManaged = $false; continue }
    for ($j = $i + 1; $j -lt $lines.Count; $j++) {
      if ($lines[$j].Trim().StartsWith('[')) { break }
      $k = $lines[$j].Split('#')[0].Split('=')[0].Trim().Trim('"')
      if ($k -and ($mKeys[$h] -cnotcontains $k)) { $allManaged = $false; break }
    }
  }
  $replaceUnmarked = [bool]$wantMantle -and $allManaged
  if ($replaceUnmarked) { foreach ($i in $unmarked) { $mOursAt[$i] = $true } }
  $ownM = ($unmarked.Count -gt 0) -and -not $replaceUnmarked
  $defaultMantle = $wantMantle -and -not $ownM
  if ($wantMantle -and $ownM -and -not $quiet) {
    Say "$CodexConfigFile has its own [model_providers.amazon-bedrock.*]; codex stays on bedrock-runtime by default (mantle: codex -p mantle)"
  }
  $topKey = '^\s*(model_provider|model|web_search)\s*='
  $out = New-Object Collections.Generic.List[string]
  $inTop = $true; $inOurs = $false
  for ($idx = 0; $idx -lt $lines.Count; $idx++) {
    $line = $lines[$idx]
    if ($line.Trim().StartsWith('[')) {
      $inTop = $false
      $h = Get-TomlHeader $line
      $inOurs = (@($table, $perms, $permsFs, $mProfile) -ccontains $h) -or $mOursAt.ContainsKey($idx)
      if ($inOurs) { continue }
    }
    if ($inOurs -or $line.Contains($CodexMark) -or ($inTop -and $line -cmatch $topKey)) { continue }
    $out.Add($line)
  }
  # Drop the blank lines our removals leave behind (edges + doubled gaps).
  $clean = New-Object Collections.Generic.List[string]
  for ($i = 0; $i -lt $out.Count; $i++) {
    if ($out[$i].Trim() -or ($i -gt 0 -and $out[$i - 1].Trim())) { $clean.Add($out[$i]) }
  }
  while ($clean.Count -and -not $clean[0].Trim()) { $clean.RemoveAt(0) }
  while ($clean.Count -and -not $clean[$clean.Count - 1].Trim()) { $clean.RemoveAt($clean.Count - 1) }

  $q = { param($v) ConvertTo-TomlString $v }
  $mModel = if ($mantle.Contains('model') -and $mantle['model']) { $mantle['model'] } else { 'openai.gpt-6.1-sol' }
  $mRegion = if ($mantle.Contains('region') -and $mantle['region']) { $mantle['region'] } else { 'us-east-1' }
  $mProj = if ($mantle.Contains('projectId') -and $mantle['projectId']) { [string]$mantle['projectId'] } else { '' }
  # IAM allows only the user's own project: without the header the call lands in
  # project/default and is denied.
  $mTables = @('', "$mAws  $CodexMark", "profile = $(& $q $AwsProfileName)", "region = $(& $q $mRegion)",
    '', "$mHdr  $CodexMark", "OpenAI-Project = $(& $q $mProj)")
  if ($mode -eq 'add') {
    $head = New-Object Collections.Generic.List[string]
    if ($defaultMantle) {
      $head.Add("model_provider = `"amazon-bedrock`"  $CodexMark")
      $head.Add("model = $(& $q $mModel)  $CodexMark")
      $head.Add("web_search = `"live`"  $CodexMark")
    } else {
      $head.Add("model_provider = `"amazon-bedrock-runtime`"  $CodexMark")
      $head.Add("model = $(& $q $Models['CODEX_MODEL'])  $CodexMark")
      $head.Add("web_search = `"disabled`"  $CodexMark")
    }
    $tail = New-Object Collections.Generic.List[string]
    $tail.AddRange([string[]]@('', "$table  $CodexMark", "profile = $(& $q $AwsProfileName)", "region = $(& $q $AwsRegion)"))
    if ($defaultMantle) { $tail.AddRange([string[]]$mTables) }
    # Keep commands Codex runs away from the cached refresh token and STS keys
    # (permission profile on :workspace denying the CLI dir; enforced by the
    # sandbox). A user who chose their own sandbox keeps it and gets a warning.
    # Native Windows: not written. The unelevated Windows sandbox does not support
    # denied read paths and Codex refuses a profile it cannot enforce, so the profile
    # broke Codex at start; a copy from an older install is stripped above.
    $own = @($clean | Where-Object { $_ -cmatch '^\s*(default_permissions|sandbox_mode)\s*=' -or $_.Split('#')[0].Trim() -eq '[sandbox_workspace_write]' })
    if ($OnWindows) {
      # Reported by Invoke-Setup on stdout (the setup summary), not here.
    } elseif ($own.Count) {
      if (-not $quiet) { Say "$CodexConfigFile sets its own sandbox; add a read deny for $CfgDir yourself (see Codex permissions docs)" }
    } else {
      $head.Add("default_permissions = `"cc-bedrock`"  $CodexMark")
      $tail.AddRange([string[]]@('', "$perms  $CodexMark", 'extends = ":workspace"', '', "$permsFs  $CodexMark", "$(& $q $CfgDir) = `"deny`""))
    }
    $merged = New-Object Collections.Generic.List[string]
    $merged.AddRange($head)
    if ($clean.Count) { $merged.Add(''); $merged.AddRange($clean) }
    $merged.AddRange($tail)
    $clean = $merged
  }
  if ($wantMantle -and $mOurs) {
    # The em dash matches the bash CLI byte for byte (kept out of this ASCII file).
    $m = @("$CodexMark $([char]0x2014) bedrock-mantle (web search). NOT counted in usage or budget;",
      '# granted only while your cost is unlimited. Use: codex -p mantle',
      'model_provider = "amazon-bedrock"', "model = $(& $q $mModel)", 'web_search = "live"')
    $m += @($mTables | ForEach-Object { $_.Replace("  $CodexMark", '') })
    Write-TextFile $mPath (($m -join "`n") + "`n")
  } elseif ($wantMantle -and -not $quiet) {
    Say "$mPath is your own file - not adding the mantle profile"
  } elseif ($mOurs -and (Test-Path -LiteralPath $mPath)) {
    Remove-Item -LiteralPath $mPath -Force
  }
  if ($defaultMantle -and $rOurs) {
    $r = @("$CodexMark $([char]0x2014) bedrock-runtime (metered: counted in usage and budget, no web search).",
      '# Use: codex -p runtime',
      'model_provider = "amazon-bedrock-runtime"', "model = $(& $q $Models['CODEX_MODEL'])", 'web_search = "disabled"')
    Write-TextFile $rPath (($r -join "`n") + "`n")
  } elseif ($defaultMantle -and -not $quiet) {
    Say "$rPath is your own file - not adding the runtime profile"
  } elseif ($rOurs -and (Test-Path -LiteralPath $rPath)) {
    Remove-Item -LiteralPath $rPath -Force
  }
  $body = ($clean -join "`n")
  if ($clean.Count) { $body += "`n" }
  Write-TextFile $CodexConfigFile $body
}

# @(provider, model) that config.toml actually defaults to (our managed keys; empty
# before setup), so messages report what was applied, not what was granted.
function Get-CodexDefault {
  $r = @('', '')
  foreach ($l in ((Read-TextFile $CodexConfigFile) -split "`r?`n")) {
    if ($l -cmatch '^model_provider = "([^"]*)"  # managed by cc-bedrock-local$') { $r[0] = $Matches[1] }
    elseif ($l -cmatch '^model = "([^"]*)"  # managed by cc-bedrock-local$') { $r[1] = $Matches[1] }
  }
  return $r
}

function Get-MantleNote {
  $s = Read-State
  if ($s -and $s.Contains('mantle') -and $s['mantle'] -and $s['mantle']['enabled']) {
    $m = $s['mantle']
    if ((Get-CodexDefault)[0] -ceq 'amazon-bedrock') {
      return "mantle ($($m['model']), $($m['region'])): DEFAULT for codex + the Codex app - web search; NOT counted in usage or budget; metered runtime: codex -p runtime; available while your cost is unlimited"
    }
    return "mantle ($($m['model']), $($m['region'])): codex -p mantle - web search; NOT counted in usage or budget; not the codex default (config.toml has its own amazon-bedrock provider, or setup has not run); available while your cost is unlimited"
  }
  return ''
}

# After new credentials keep the Codex mantle profile in step with the grant. Gated
# on our own Codex keys, not on Claude's settings, so a revocation always reverts Codex.
function Sync-CodexMantle {
  if (-not (Read-TextFile $CodexConfigFile).Contains($CodexMark)) { return }
  try { Set-CodexConfig 'add' $true } catch { Say "could not update $CodexConfigFile" }
}

function Invoke-Setup([bool]$quietOutput = $false) {
  Require-Config
  # Harden an existing CLI dir too (only a dir this CLI creates was protected).
  Protect-Path $CfgDir
  Install-AwsProfile
  Set-ClaudeSettings
  Set-CodexConfig 'add'
  if (-not $quietOutput) {
    $hookNote = if (Test-SessionReportEnabled) { ' + Stop hook session-report' } else { '; SESSION_REPORT=off, no Stop hook' }
    Out "OK claude -> Bedrock (${ClaudeSettingsFile}: env + awsCredentialExport${hookNote}) - Claude Code CLI and the Claude Desktop Code tab"
    $applied = Get-CodexDefault
    Out "OK codex  -> Bedrock (${CodexConfigFile}: $($applied[0]), profile=$AwsProfileName, model=$($applied[1])) - Codex CLI and the Codex app"
    Out '  restart Claude Desktop / the Codex app so they reload their settings'
    $note = Get-MantleNote
    if ($note) { Out "! $note" }
    if ($OnWindows) { Out "! Windows: Codex gets no read-deny for $CfgDir (the Windows sandbox cannot enforce it), so commands Codex runs can read your session keys there (ADR-014)" }
  }
  if ($OnWindows) {
    $ka = Install-KeepAlive
    if (-not $quietOutput) {
      if ($ka) { Out "OK sign-in keep-alive ($ka); KEEPALIVE=off in the config disables it" }
      elseif (-not (Test-KeepAliveEnabled)) { Out '  KEEPALIVE=off: no keep-alive task (sign in again with: cc-bedrock-local login)' }
    }
  }
  # A Bedrock API key outranks the profile in both tools and would bypass the
  # per-user role (metering, budget deny).
  $bearer = $env:AWS_BEARER_TOKEN_BEDROCK
  if (-not $bearer -and $OnWindows) { $bearer = [Environment]::GetEnvironmentVariable('AWS_BEARER_TOKEN_BEDROCK', 'User') }
  if ($bearer) { Say 'AWS_BEARER_TOKEN_BEDROCK is set - claude/codex would use that key instead of your cc-bedrock role; remove it (System > Environment Variables)' }
  if (-not $quietOutput) {
    if (-not (Get-Command claude -ErrorAction SilentlyContinue)) { Say 'claude not found - install Claude Code (https://code.claude.com/docs/en/setup) or use Claude Desktop' }
    if (-not (Get-Command codex -ErrorAction SilentlyContinue)) { Say 'codex not found - install: npm install -g @openai/codex@0.163.0, or use the Codex app' }
  }
  Start-SessionSweep
}

function Invoke-Unsetup {
  Remove-ClaudeSettings
  Set-CodexConfig 'remove'
  Remove-KeepAlive
  Out "OK removed Bedrock settings from $ClaudeSettingsFile and $CodexConfigFile"
}

# --- Claude Desktop third-party mode (Cowork / Chat) --------
# Opt-in: inferenceProvider=bedrock switches the whole app from claude.ai sign-in
# to Bedrock. Credentials come from the named profile (credential_process above);
# the app needs AWS CLI v2 to read it. Values are REG_SZ directly under the key.
$DesktopValueNames = @('inferenceProvider', 'inferenceBedrockRegion', 'inferenceBedrockProfile', 'inferenceBedrockAwsCliPath', 'inferenceModels', 'coworkEgressAllowedHosts')

function Get-DesktopValues {
  $list = @(
    [ordered]@{ name = $Models['ANTHROPIC_DEFAULT_SONNET_MODEL']; anthropicFamilyTier = 'sonnet' },
    [ordered]@{ name = $Models['ANTHROPIC_DEFAULT_OPUS_MODEL']; anthropicFamilyTier = 'opus' },
    [ordered]@{ name = $Models['ANTHROPIC_DEFAULT_HAIKU_MODEL']; anthropicFamilyTier = 'haiku' }
  )
  $v = [ordered]@{
    inferenceProvider       = 'bedrock'
    inferenceBedrockRegion  = $AwsRegion
    inferenceBedrockProfile = $AwsProfileName
  }
  $aws = Get-Command aws -ErrorAction SilentlyContinue
  if ($aws) { $v['inferenceBedrockAwsCliPath'] = $aws.Source }
  $v['inferenceModels'] = (ConvertTo-Json -InputObject $list -Depth 4 -Compress)
  # Chat/Cowork refuse every web fetch while coworkEgressAllowedHosts is unset or
  # empty ("your organization's network settings block this website"). Owner
  # decision 2026-11-03: allow all hosts by default; DESKTOP_EGRESS_HOSTS in the
  # config narrows it (comma-separated: docs.aws.amazon.com,*.github.com); 'none'
  # blocks every fetch. An explicit value that yields no host also blocks: a
  # setting must never widen to '*'.
  $raw = Cfg 'DESKTOP_EGRESS_HOSTS' '*'
  $hosts = @($raw.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ -and $_ -ne 'none' })
  $v['coworkEgressAllowedHosts'] = if ($hosts.Count) { (ConvertTo-Json -InputObject $hosts -Compress) } else { '[]' }
  return $v
}

# HKCU\SOFTWARE\Policies is often admin-only. Fallback: write a .reg file and import it
# through a UAC prompt (reg.exe elevated with the same account writes the same HKCU),
# then confirm by reading the values back without elevation. A declined prompt, or an
# elevation as another account, leaves the .reg file for the user or IT.
function Write-DesktopRegFile([string[]]$valueLines) {
  $lines = @('Windows Registry Editor Version 5.00', '', '[HKEY_CURRENT_USER\SOFTWARE\Policies\Claude]') + $valueLines
  [IO.File]::WriteAllText($DesktopRegFile, (($lines -join "`r`n") + "`r`n"), [Text.Encoding]::Unicode)
}
function Import-RegElevated {
  try {
    $p = Start-Process -FilePath 'reg.exe' -ArgumentList @('import', ('"' + $DesktopRegFile + '"')) -Verb RunAs -Wait -PassThru -WindowStyle Hidden
    return ($p.ExitCode -eq 0)
  } catch { return $false }
}
function Get-DesktopValue([string]$name) {
  try { return [string](Get-ItemProperty -Path $DesktopPolicyKey -Name $name -ErrorAction Stop).$name } catch { return $null }
}

function Invoke-SetupDesktop {
  if (-not $OnWindows) { Die 'setup-desktop configures Claude Desktop on Windows only' }
  Require-Config
  Install-AwsProfile
  if (-not (Get-Command aws -ErrorAction SilentlyContinue)) {
    Say 'AWS CLI v2 not found - Claude Desktop reads the cc-bedrock profile through it. Install: https://awscli.amazonaws.com/AWSCLIV2.msi, then re-run setup-desktop'
  }
  if (Test-Path 'HKLM:\SOFTWARE\Policies\Claude') {
    Say 'HKLM\SOFTWARE\Policies\Claude exists (machine policy) - Claude Desktop ignores the user policy; ask IT to deploy these values instead'
  }
  $vals = Get-DesktopValues
  $key = $DesktopPolicyKey -replace ':', ''
  try {
    if (-not (Test-Path $DesktopPolicyKey)) { New-Item -Path $DesktopPolicyKey -Force | Out-Null }
    foreach ($k in $vals.Keys) { New-ItemProperty -Path $DesktopPolicyKey -Name $k -Value $vals[$k] -PropertyType String -Force | Out-Null }
  } catch {
    Say "no write access to $key ($($_.Exception.Message)) - asking Windows for permission (UAC)"
    $valueLines = @()
    foreach ($k in $vals.Keys) { $valueLines += ('"{0}"="{1}"' -f $k, ($vals[$k].Replace('\', '\\').Replace('"', '\"'))) }
    Write-DesktopRegFile $valueLines
    [void](Import-RegElevated)
  }
  $ok = $true
  foreach ($k in $vals.Keys) { if ((Get-DesktopValue $k) -cne [string]$vals[$k]) { $ok = $false } }
  if ($ok) {
    Out "OK Claude Desktop -> Bedrock ($key`: inferenceProvider=bedrock, profile=$AwsProfileName)"
    Out '  quit Claude Desktop from the tray and reopen it; undo: cc-bedrock-local unsetup-desktop'
  } else {
    Out "  not applied - double-click $DesktopRegFile (answer Yes to UAC) or ask IT to deploy it, then reopen Claude Desktop"
  }
}

function Invoke-UnsetupDesktop {
  if (-not $OnWindows) { Die 'unsetup-desktop is Windows only' }
  if (Test-Path $DesktopPolicyKey) {
    foreach ($k in $DesktopValueNames) { Remove-ItemProperty -Path $DesktopPolicyKey -Name $k -ErrorAction SilentlyContinue }
  }
  $left = @($DesktopValueNames | Where-Object { $null -ne (Get-DesktopValue $_) })
  if ($left.Count) {
    Say "no write access to $($DesktopPolicyKey -replace ':', '') - asking Windows for permission (UAC)"
    Write-DesktopRegFile @($left | ForEach-Object { ('"{0}"=-' -f $_) })
    [void](Import-RegElevated)
    $left = @($DesktopValueNames | Where-Object { $null -ne (Get-DesktopValue $_) })
  }
  if ($left.Count) {
    Out "  not removed - double-click $DesktopRegFile (answer Yes to UAC), then reopen Claude Desktop"
  } else {
    Out 'OK removed Claude Desktop Bedrock policy values (reopen Claude Desktop)'
  }
}

# --- session-report (session insights, client side) ---------
# Same contract as session_report_main in the bash CLI: reads local Claude Code
# transcripts (~\.claude\projects\<proj>\<sessionId>.jsonl + <sessionId>\subagents\*.jsonl)
# and Codex rollouts (~\.codex\sessions\**\rollout-*.jsonl), sums turns and per-model
# tokens per (tool, sessionId, UTC date) bucket, and POSTs the cumulative buckets that
# changed to /api/local/sessions. Insight only: budgets and metering stay on Bedrock
# invocation logs (ADR-005). sessions-state.json keeps per-file byte offsets, so a run
# parses only what was appended. Never prompts; --quiet (the Stop hook) writes nothing
# to stdout, logs failures to session-report.log and always exits 0.
$SrSidRe = '^[A-Za-z0-9._:-]{1,128}$'
$SrFields = @('inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens')
$SrJsonDateKind = (Get-Command ConvertFrom-Json).Parameters.ContainsKey('DateKind')
$SrInv = [Globalization.CultureInfo]::InvariantCulture

function Write-SessionLog([string]$msg, [bool]$quiet = $true) {
  try {
    $lines = New-Object Collections.Generic.List[string]
    if (Test-Path -LiteralPath $SessionLogFile) { $lines.AddRange([string[]]([IO.File]::ReadAllLines($SessionLogFile))) }
    $lines.Add([DateTime]::UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", $SrInv) + ' ' + $msg)
    if ($lines.Count -gt 200) { $lines.RemoveRange(0, $lines.Count - 200) }
    $new = -not (Test-Path -LiteralPath $SessionLogFile)
    [IO.File]::WriteAllText($SessionLogFile, (($lines -join "`n") + "`n"), $Utf8NoBom)
    if ($new) { Protect-Path $SessionLogFile $true }
  } catch { }
  if (-not $quiet) { Say $msg }
}

# --- keep-alive + sign-in window (Windows) -------------------
# Users never need a console: a hidden scheduled task (every 30 min; StartWhenAvailable
# catches up after sleep) and a Startup entry (at logon) run 'keepalive', which renews
# the STS credentials ahead of expiry. Claude Code, Codex and the desktop apps then
# find fresh credentials in state.json, so their credential_process call is a cache
# hit, far inside SDK load timeouts. When the sign-in itself expired it shows a
# password window (at most every 4 h); the Start menu entry 'cc-bedrock sign in'
# opens the same window on demand. KEEPALIVE=off in the config disables all of it.
$KeepAlive = Cfg 'KEEPALIVE' 'on'
# CC_BEDROCK_KEEPALIVE_NAME (tests only) renames the task, the Startup entry and the
# Start menu entry, so a smoke run never replaces the user's own keep-alive.
$KeepAliveTask = if ($env:CC_BEDROCK_KEEPALIVE_NAME) { $env:CC_BEDROCK_KEEPALIVE_NAME } else { 'cc-bedrock-keepalive' }
$SignInName = if ($env:CC_BEDROCK_KEEPALIVE_NAME) { "$($env:CC_BEDROCK_KEEPALIVE_NAME) sign in" } else { 'cc-bedrock sign in' }
$KeepAliveLog = Join-Path $CfgDir 'keepalive.log'
$SignInStamp = Join-Path $CfgDir 'signin-prompted-at'
$KeepAliveVbs = Join-Path (Split-Path -Parent $PSCommandPath) 'cc-bedrock-keepalive.vbs'
$SignInVbs = Join-Path (Split-Path -Parent $PSCommandPath) 'cc-bedrock-signin.vbs'
function Test-KeepAliveEnabled { return $OnWindows -and -not (@('off', 'OFF', 'Off') -ccontains $KeepAlive) }
function Get-StartupEntry { return (Join-Path ([Environment]::GetFolderPath('Startup')) "$KeepAliveTask.vbs") }
function Get-SignInShortcut { return (Join-Path ([Environment]::GetFolderPath('Programs')) "$SignInName.lnk") }

function Write-KeepAliveLog([string]$msg) {
  try {
    $lines = New-Object Collections.Generic.List[string]
    if (Test-Path -LiteralPath $KeepAliveLog) { $lines.AddRange([string[]]([IO.File]::ReadAllLines($KeepAliveLog))) }
    $lines.Add([DateTime]::UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", [Globalization.CultureInfo]::InvariantCulture) + ' ' + $msg)
    if ($lines.Count -gt 200) { $lines.RemoveRange(0, $lines.Count - 200) }
    $new = -not (Test-Path -LiteralPath $KeepAliveLog)
    [IO.File]::WriteAllText($KeepAliveLog, (($lines -join "`n") + "`n"), $Utf8NoBom)
    if ($new) { Protect-Path $KeepAliveLog $true }
  } catch { }
}

# wscript runs PowerShell with no window at all (-WindowStyle Hidden alone still
# flashes a console). UTF-16 with BOM so a non-ASCII profile path survives.
# $wait: wscript waits for PowerShell, so the task's IgnoreNew and time limit apply to
# the keep-alive itself (the Start menu sign-in returns at once).
function Write-Launcher([string]$path, [string]$subArgs, [bool]$wait) {
  $cmd = 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File ""' + $PSCommandPath + '"" ' + $subArgs
  $text = "' cc-bedrock-local launcher (managed by cc-bedrock-local; runs with no window)`r`n" +
    'CreateObject("WScript.Shell").Run "' + $cmd + '", 0, ' + $(if ($wait) { 'True' } else { 'False' }) + "`r`n"
  [IO.File]::WriteAllText($path, $text, [Text.Encoding]::Unicode)
}

function Register-KeepAliveTask {
  $action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('"' + $KeepAliveVbs + '"')
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 1) -MultipleInstances IgnoreNew
  # First run in a minute; a test run (renamed task) waits a day so it never fires
  # against the real profile.
  $at = if ($env:CC_BEDROCK_KEEPALIVE_NAME) { (Get-Date).AddDays(1) } else { (Get-Date).AddMinutes(1) }
  $every = New-TimeSpan -Minutes 30
  $desc = 'Keeps the cc-bedrock sign-in fresh for Claude Code and Codex (cc-bedrock-local keepalive).'
  # Some Windows builds reject a long RepetitionDuration when the task is registered,
  # others need one; try both.
  try {
    $trigger = New-ScheduledTaskTrigger -Once -At $at -RepetitionInterval $every -RepetitionDuration (New-TimeSpan -Days 3650)
    Register-ScheduledTask -TaskName $KeepAliveTask -Action $action -Trigger $trigger -Settings $settings -Description $desc -Force -ErrorAction Stop | Out-Null
  } catch {
    $trigger = New-ScheduledTaskTrigger -Once -At $at -RepetitionInterval $every
    Register-ScheduledTask -TaskName $KeepAliveTask -Action $action -Trigger $trigger -Settings $settings -Description $desc -Force -ErrorAction Stop | Out-Null
  }
}

# Returns a one-line summary for setup.
function Install-KeepAlive {
  if (-not (Test-KeepAliveEnabled)) { Remove-KeepAlive; return '' }
  Write-Launcher $KeepAliveVbs 'keepalive' $true
  Write-Launcher $SignInVbs 'keepalive --sign-in' $false
  $parts = New-Object Collections.Generic.List[string]
  try { Register-KeepAliveTask; $parts.Add('scheduled task every 30 min') }
  catch { Say "could not register the keep-alive task ($($_.Exception.Message)); sign-in still renews at logon and on use" }
  try { Copy-Item -LiteralPath $KeepAliveVbs -Destination (Get-StartupEntry) -Force; $parts.Add('at logon') }
  catch { Say "could not add the Startup entry ($($_.Exception.Message))" }
  try {
    $ws = New-Object -ComObject WScript.Shell
    $lnk = $ws.CreateShortcut((Get-SignInShortcut))
    $lnk.TargetPath = Join-Path $env:SystemRoot 'System32\wscript.exe'
    $lnk.Arguments = '"' + $SignInVbs + '"'
    $lnk.Description = 'Sign in to cc-bedrock (Claude Code / Codex on Bedrock)'
    $lnk.Save()
    $parts.Add("Start menu '$SignInName'")
  } catch { Say "could not add the Start menu entry ($($_.Exception.Message))" }
  return ($parts -join ', ')
}

function Remove-KeepAlive {
  if (-not $OnWindows) { return }
  try { Unregister-ScheduledTask -TaskName $KeepAliveTask -Confirm:$false -ErrorAction Stop } catch { }
  foreach ($f in @((Get-StartupEntry), (Get-SignInShortcut), $KeepAliveVbs, $SignInVbs)) {
    Remove-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue
  }
}

function Read-PasswordWindow([string]$message) {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  [Windows.Forms.Application]::EnableVisualStyles()
  $f = New-Object Windows.Forms.Form
  $f.Text = 'cc-bedrock sign in'
  $f.FormBorderStyle = [Windows.Forms.FormBorderStyle]::FixedDialog
  $f.StartPosition = [Windows.Forms.FormStartPosition]::CenterScreen
  $f.MaximizeBox = $false; $f.MinimizeBox = $false; $f.TopMost = $true; $f.ShowInTaskbar = $true
  $f.ClientSize = New-Object Drawing.Size(400, 150)
  $l = New-Object Windows.Forms.Label
  $l.Text = $message
  $l.SetBounds(12, 10, 376, 50)
  $t = New-Object Windows.Forms.TextBox
  $t.UseSystemPasswordChar = $true
  $t.SetBounds(12, 66, 376, 24)
  $ok = New-Object Windows.Forms.Button
  $ok.Text = 'Sign in'
  $ok.DialogResult = [Windows.Forms.DialogResult]::OK
  $ok.SetBounds(216, 108, 80, 28)
  $no = New-Object Windows.Forms.Button
  $no.Text = 'Cancel'
  $no.DialogResult = [Windows.Forms.DialogResult]::Cancel
  $no.SetBounds(308, 108, 80, 28)
  $f.Controls.AddRange([Windows.Forms.Control[]]@($l, $t, $ok, $no))
  $f.AcceptButton = $ok
  $f.CancelButton = $no
  $f.Add_Shown({ $f.Activate(); [void]$t.Focus() })
  try {
    if ($f.ShowDialog() -eq [Windows.Forms.DialogResult]::OK) { return $t.Text }
    return ''
  } finally { $f.Dispose() }
}

function Show-Notice([string]$text, [bool]$isError = $false) {
  try {
    Add-Type -AssemblyName System.Windows.Forms
    $icon = if ($isError) { [Windows.Forms.MessageBoxIcon]::Warning } else { [Windows.Forms.MessageBoxIcon]::Information }
    [void][Windows.Forms.MessageBox]::Show($text, 'cc-bedrock sign in', [Windows.Forms.MessageBoxButtons]::OK, $icon)
  } catch { }
}

# Password sign-in + STS issue without a console. Returns '' on success, else the error.
function Invoke-PasswordSignIn([string]$password) {
  try { $auth = Invoke-Cognito @{ USERNAME = $script:Email; PASSWORD = $password } 'USER_PASSWORD_AUTH' } catch { return $_.Exception.Message }
  if (-not $auth['AccessToken']) { return 'Cognito did not return an access token' }
  Save-Tokens $auth['AccessToken'] $auth['RefreshToken']
  $raw = Request-Sts $auth['AccessToken']
  if (-not $raw) { return 'the dashboard refused to issue credentials (budget limit? ask your admin)' }
  Install-AwsProfile
  Save-State $raw
  try { Sync-CodexMantle } catch { }
  return ''
}

# $onDemand: the Start menu entry (always shows). Otherwise at most every 4 h, so a
# dismissed window does not return every 30 minutes.
function Show-SignIn([bool]$onDemand) {
  if (-not $OnWindows) { return }
  if (-not $script:Email) { Show-Notice "EMAIL is not set in $CfgFile - run the installer again." $true; return }
  if (-not $onDemand) {
    if (Test-Path -LiteralPath $SignInStamp) {
      $age = ([DateTime]::UtcNow - (Get-Item -LiteralPath $SignInStamp).LastWriteTimeUtc).TotalHours
      if ($age -lt 4) { return }
    }
    [IO.File]::WriteAllText($SignInStamp, [string](Get-EpochNow), $Utf8NoBom)
  }
  $msg = "Your cc-bedrock sign-in has expired (it lasts 30 days).`r`nPassword for $($script:Email):"
  if ($onDemand) { $msg = "Sign in to cc-bedrock (Claude Code / Codex on Bedrock).`r`nPassword for $($script:Email):" }
  for ($try = 1; $try -le 3; $try++) {
    $pw = Read-PasswordWindow $msg
    if (-not $pw) { Write-KeepAliveLog 'sign-in window dismissed'; return }
    $err = Invoke-PasswordSignIn $pw
    if (-not $err) {
      Write-KeepAliveLog 'signed in from the sign-in window'
      Remove-Item -LiteralPath $SignInStamp -Force -ErrorAction SilentlyContinue
      Show-Notice "Signed in as $($script:Email). Claude Code and Codex can be used again."
      return
    }
    Write-KeepAliveLog "sign-in failed: $err"
    $msg = "Sign-in failed: $err`r`nPassword for $($script:Email):"
  }
}

function Invoke-KeepAlive([string[]]$argv) {
  if (-not $DashboardUrl -or -not $CognitoClientId) { return }
  if ($argv -contains '--sign-in') { Show-SignIn $true; return }
  # More than 40 min left: nothing to do (the task runs every 30 min, creds last 1 h).
  if (Test-StateFresh (Read-State) 2400) { return }
  for ($try = 1; $try -le 5; $try++) {
    $kind = ''
    $lock = Enter-RefreshLock
    try {
      if (Test-StateFresh (Read-State) 2400) { return }
      $r = Invoke-CognitoRefresh
      $kind = $r.Kind
      if ($kind -eq 'ok') {
        $raw = $null
        try { $raw = Request-Sts $r.Access } catch { Write-KeepAliveLog "dashboard unreachable ($($_.Exception.Message))" }
        if ($raw) { Save-State $raw; Write-KeepAliveLog 'renewed credentials' }
        else { $kind = 'transient'; Write-KeepAliveLog 'dashboard refused STS issue' }
      } else {
        Write-KeepAliveLog $r.Message
      }
    } finally {
      Exit-RefreshLock $lock
    }
    if ($kind -eq 'ok') { try { Sync-CodexMantle } catch { }; return }
    if ($kind -eq 'dead') { Show-SignIn $false; return }
    # Right after logon or wake the network may not be up yet.
    if ($try -lt 5) { Start-Sleep -Seconds (15 * $try) }
  }
}

# Detached background sweep (after setup, login and a credential-process refresh):
# hidden, no wait, stdout/stderr not shared with the caller. Skipped when session
# reporting is off or there is no Cognito session to send with.
function Start-SessionSweep {
  if (-not (Test-SessionReportEnabled) -or -not (Test-Path -LiteralPath $TokenCache)) { return }
  Start-Detached @('session-report', '--sweep', '--quiet')
}

# Run this CLI detached: hidden, no wait, and no handles shared with the caller
# (an SDK reading credential-process stdout must see EOF when we exit).
function Start-Detached([string[]]$cliArgs) {
  try {
    $a = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $PSCommandPath + '"')) + $cliArgs
    if ($OnWindows) {
      Start-Process -FilePath 'powershell.exe' -ArgumentList $a -WindowStyle Hidden | Out-Null
    } else {
      Start-Process -FilePath 'pwsh' -ArgumentList $a -RedirectStandardOutput '/dev/null' -RedirectStandardError (Join-Path $CfgDir 'session-sweep.err') | Out-Null
    }
  } catch { }
}

# Cached Cognito access token while > 5 min remain, else a silent refresh from the
# cached refresh token (re-cached). '' when there is none. Never prompts.
function Get-SessionAccessToken {
  if (-not (Test-Path -LiteralPath $TokenCache)) { return '' }
  try {
    $t = ConvertFrom-JsonText (Read-TextFile $TokenCache)
    if ($t -and $t.Contains('accessToken') -and $t['accessToken'] -and $t.Contains('accessExpiresAt') -and (([long]$t['accessExpiresAt']) - (Get-EpochNow) -gt 300)) {
      return [string]$t['accessToken']
    }
  } catch { }
  if (-not $CognitoClientId) { return '' }
  $lock = Enter-RefreshLock
  try { $r = Invoke-CognitoRefresh } catch { return '' } finally { Exit-RefreshLock $lock }
  if ($r.Kind -ne 'ok') { return '' }
  return $r.Access
}

# Property of a parsed JSON line (PSCustomObject), $null when absent (StrictMode-safe).
function Get-P($o, [string]$name) {
  if ($null -eq $o -or $o.GetType().FullName -ne 'System.Management.Automation.PSCustomObject') { return $null }
  $p = $o.PSObject.Properties[$name]
  if ($null -eq $p) { return $null }
  return , $p.Value
}

function ConvertFrom-JsonLine([string]$text) {
  try {
    if ($SrJsonDateKind) { return ($text | ConvertFrom-Json -DateKind String) }
    return ($text | ConvertFrom-Json)
  } catch { return $null }
}

function Get-Count($v) {
  if (($v -is [int] -or $v -is [long]) -and $v -gt 0) { return [long]$v }
  return [long]0
}

# @(ISO-8601 UTC with ms, YYYY-MM-DD) or $null. PS 7 < 7.5 turns ISO strings into DateTime.
function Get-Stamp($v) {
  if ($v -is [datetime]) {
    $d = $v.ToUniversalTime()
  } elseif ($v -is [string] -and $v -cmatch '^(\d{4}-\d\d-\d\d)T(\d\d:\d\d:\d\d)(?:\.(\d+))?Z$') {
    $frac = ([string]$Matches[3] + '000').Substring(0, 3)
    return @(($Matches[1] + 'T' + $Matches[2] + '.' + $frac + 'Z'), $Matches[1])
  } elseif ($v -is [string]) {
    try { $d = [DateTimeOffset]::Parse($v, $SrInv, [Globalization.DateTimeStyles]::AssumeUniversal).UtcDateTime } catch { return $null }
  } else {
    return $null
  }
  return @($d.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", $SrInv), $d.ToString('yyyy-MM-dd', $SrInv))
}

function New-SrBucket { return [ordered]@{ firstAt = $null; lastAt = $null; turns = [long]0; models = [ordered]@{} } }

function Get-SrBucket($fs, [string]$key) {
  if (-not $fs['buckets'].Contains($key)) { $fs['buckets'][$key] = New-SrBucket }
  return $fs['buckets'][$key]
}

function Update-SrTimes($b, [string]$iso) {
  if (-not $b['firstAt'] -or [string]::CompareOrdinal($iso, [string]$b['firstAt']) -lt 0) { $b['firstAt'] = $iso }
  if (-not $b['lastAt'] -or [string]::CompareOrdinal($iso, [string]$b['lastAt']) -gt 0) { $b['lastAt'] = $iso }
}

function Get-SrModelRow($b, [string]$model) {
  if (-not $b['models'].Contains($model)) {
    $b['models'][$model] = [ordered]@{ requests = [long]0; inputTokens = [long]0; outputTokens = [long]0; cacheReadTokens = [long]0; cacheWriteTokens = [long]0 }
  }
  return $b['models'][$model]
}

function Add-ClaudeLine($fs, $d, [bool]$isSub) {
  $t = Get-P $d 'type'
  if ($t -cne 'user' -and $t -cne 'assistant') { return }
  $sid = Get-P $d 'sessionId'
  if (-not ($sid -is [string]) -or $sid -cnotmatch $SrSidRe) { return }
  $st = Get-Stamp (Get-P $d 'timestamp')
  if (-not $st) { return }
  $key = 'claude|' + $sid + '|' + $st[1]
  $msg = Get-P $d 'message'
  if ($t -ceq 'user') {
    if ($isSub -or [bool](Get-P $d 'isMeta') -or [bool](Get-P $d 'isCompactSummary') -or [bool](Get-P $d 'isSidechain')) { return }
    $c = Get-P $msg 'content'
    $text = $null
    if ($c -is [string]) {
      $text = $c
    } elseif ($c -is [array]) {
      $hasResult = $false
      foreach ($x in $c) {
        $xt = Get-P $x 'type'
        if ($xt -ceq 'tool_result') { $hasResult = $true }
        elseif ($xt -ceq 'text' -and $null -eq $text) {
          $tx = Get-P $x 'text'
          $text = if ($tx -is [string]) { $tx } else { '' }
        }
      }
      if ($hasResult -or $null -eq $text) { return }
    } else {
      return
    }
    if ($text.TrimStart() -cmatch '^<(local-command-|command-(stdout|caveat))') { return }
    $b = Get-SrBucket $fs $key
    $b['turns'] = [long]$b['turns'] + 1
    Update-SrTimes $b $st[0]
    return
  }
  $model = Get-P $msg 'model'
  if (-not ($model -is [string]) -or -not $model -or $model -ceq '<synthetic>' -or $model.Length -gt 128) { return }
  $u = Get-P $msg 'usage'
  $vals = @((Get-Count (Get-P $u 'input_tokens')), (Get-Count (Get-P $u 'output_tokens')),
    (Get-Count (Get-P $u 'cache_read_input_tokens')), (Get-Count (Get-P $u 'cache_creation_input_tokens')))
  $mid = Get-P $msg 'id'
  if (-not ($mid -is [string])) { $mid = '' }
  if ($mid) {
    # One API response is written as several lines with the same message.id: count it
    # once, keeping the max of each usage field.
    foreach ($e in $fs['recentIds']) {
      if ([string]$e['id'] -cne $mid) { continue }
      if ($fs['buckets'].Contains([string]$e['k'])) {
        $row = Get-SrModelRow $fs['buckets'][[string]$e['k']] ([string]$e['m'])
        for ($i = 0; $i -lt 4; $i++) {
          if ($vals[$i] -gt [long]$e['u'][$i]) {
            $row[$SrFields[$i]] = [long]$row[$SrFields[$i]] + $vals[$i] - [long]$e['u'][$i]
            $e['u'][$i] = $vals[$i]
          }
        }
      }
      return
    }
  }
  $b = Get-SrBucket $fs $key
  $row = Get-SrModelRow $b $model
  $row['requests'] = [long]$row['requests'] + 1
  for ($i = 0; $i -lt 4; $i++) { $row[$SrFields[$i]] = [long]$row[$SrFields[$i]] + $vals[$i] }
  Update-SrTimes $b $st[0]
  if ($mid) {
    $ul = New-Object Collections.ArrayList
    foreach ($v in $vals) { [void]$ul.Add($v) }
    [void]$fs['recentIds'].Add([ordered]@{ id = $mid; k = $key; m = $model; u = $ul })
    while ($fs['recentIds'].Count -gt 64) { $fs['recentIds'].RemoveAt(0) }
  }
}

function Add-CodexLine($fs, $d) {
  $t = Get-P $d 'type'
  $p = Get-P $d 'payload'
  $ctx = $fs['ctx']
  if ($t -ceq 'session_meta') {
    $sid = Get-P $p 'id'
    if ($sid -is [string] -and $sid -cmatch $SrSidRe) { $ctx['sid'] = $sid }
    return
  }
  if ($t -ceq 'turn_context') {
    $m = Get-P $p 'model'
    if ($m -is [string] -and $m.Length -gt 0 -and $m.Length -le 128) { $ctx['model'] = $m }
    return
  }
  if ($t -cne 'event_msg' -or -not $ctx.Contains('sid') -or -not $ctx['sid']) { return }
  $pt = Get-P $p 'type'
  if ($pt -cne 'task_started' -and $pt -cne 'token_count') { return }
  $st = Get-Stamp (Get-P $d 'timestamp')
  if (-not $st) { return }
  $key = 'codex|' + [string]$ctx['sid'] + '|' + $st[1]
  if ($pt -ceq 'task_started') {
    $trig = Get-P (Get-P $p 'turn_attribution') 'turn_trigger'
    if ($null -ne $trig -and $trig -cne 'user') { return }
    $b = Get-SrBucket $fs $key
    $b['turns'] = [long]$b['turns'] + 1
    Update-SrTimes $b $st[0]
    return
  }
  $last = Get-P (Get-P $p 'info') 'last_token_usage'
  if ($null -eq $last -or $last.GetType().FullName -ne 'System.Management.Automation.PSCustomObject') { return }
  $inp = Get-Count (Get-P $last 'input_tokens')
  $cr = Get-Count (Get-P $last 'cached_input_tokens')
  $cw = Get-Count (Get-P $last 'cache_write_input_tokens')
  $model = 'unknown'
  if ($ctx.Contains('model') -and $ctx['model']) { $model = [string]$ctx['model'] }
  $b = Get-SrBucket $fs $key
  $row = Get-SrModelRow $b $model
  $row['requests'] = [long]$row['requests'] + 1
  $row['inputTokens'] = [long]$row['inputTokens'] + [Math]::Max([long]0, $inp - $cr - $cw)
  $row['outputTokens'] = [long]$row['outputTokens'] + (Get-Count (Get-P $last 'output_tokens'))
  $row['cacheReadTokens'] = [long]$row['cacheReadTokens'] + $cr
  $row['cacheWriteTokens'] = [long]$row['cacheWriteTokens'] + $cw
  Update-SrTimes $b $st[0]
}

function Get-SrMtime([string]$path) {
  try {
    if (-not [IO.File]::Exists($path)) { return [long]-1 }
    return ([DateTimeOffset][IO.File]::GetLastWriteTimeUtc($path)).ToUnixTimeSeconds()
  } catch { return [long]-1 }
}

# Parse the complete lines appended since the saved offset. Returns 1 when it read.
function Update-SessionFile($state, [string]$path, [string]$tool, [bool]$isSub) {
  if (-not [IO.File]::Exists($path)) { return 0 }
  $size = (New-Object IO.FileInfo($path)).Length
  $fs = $null
  if ($state['files'].Contains($path)) { $fs = $state['files'][$path] }
  if ($null -eq $fs -or -not ($fs -is [Collections.IDictionary]) -or $size -lt [long]$fs['offset']) {
    # New, truncated or rotated file: start over.
    $fs = [ordered]@{ offset = [long]0; mtime = [long]0; size = [long]0; recentIds = (New-Object Collections.ArrayList); buckets = [ordered]@{}; ctx = [ordered]@{} }
    $state['files'][$path] = $fs
  }
  foreach ($k in @('recentIds', 'buckets', 'ctx')) {
    if (-not $fs.Contains($k) -or $null -eq $fs[$k]) { if ($k -ceq 'recentIds') { $fs[$k] = New-Object Collections.ArrayList } else { $fs[$k] = [ordered]@{} } }
  }
  $fs['mtime'] = Get-SrMtime $path
  $fs['size'] = [long]$size
  if ($size -eq [long]$fs['offset']) { return 0 }
  if ($tool -ceq 'claude') { $hints = @('"type":"user"', '"type":"assistant"', '"type": "user"', '"type": "assistant"') }
  else { $hints = @('session_meta', 'turn_context', 'task_started', 'token_count') }
  $stream = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
  try {
    [void]$stream.Seek([long]$fs['offset'], [IO.SeekOrigin]::Begin)
    $buf = New-Object byte[] 1048576
    $acc = New-Object IO.MemoryStream
    while (($n = $stream.Read($buf, 0, $buf.Length)) -gt 0) {
      $start = 0
      while ($start -lt $n) {
        $nl = [Array]::IndexOf($buf, [byte]10, $start, $n - $start)
        if ($nl -lt 0) { $acc.Write($buf, $start, $n - $start); break }
        $acc.Write($buf, $start, $nl - $start + 1)
        $start = $nl + 1
        $len = $acc.Length
        $line = $Utf8NoBom.GetString($acc.GetBuffer(), 0, [int]$len)
        $acc.SetLength(0)
        $fs['offset'] = [long]$fs['offset'] + $len
        $hit = $false
        foreach ($hint in $hints) { if ($line.Contains($hint)) { $hit = $true; break } }
        if (-not $hit) { continue }
        $d = ConvertFrom-JsonLine $line
        if ($null -eq $d -or $d.GetType().FullName -ne 'System.Management.Automation.PSCustomObject') { continue }
        if ($tool -ceq 'claude') { Add-ClaudeLine $fs $d $isSub } else { Add-CodexLine $fs $d }
      }
    }
    # Bytes left in $acc are an incomplete last line: picked up next time.
  } finally {
    $stream.Dispose()
  }
  return 1
}

function Get-SrFiles([string]$root, [string]$prefix, [long]$since) {
  $out = New-Object Collections.Generic.List[string]
  if (-not [IO.Directory]::Exists($root)) { return , $out }
  try {
    foreach ($f in [IO.Directory]::EnumerateFiles($root, '*.jsonl', [IO.SearchOption]::AllDirectories)) {
      $name = [IO.Path]::GetFileName($f)
      if ($name.EndsWith('.jsonl', [StringComparison]::Ordinal) -and $name.StartsWith($prefix, [StringComparison]::Ordinal) -and (Get-SrMtime $f) -ge $since) { $out.Add($f) }
    }
  } catch { Write-SessionLog "could not list $root ($($_.Exception.Message))" }
  return , $out
}

function Read-SessionsState {
  if (Test-Path -LiteralPath $SessionsStateFile) {
    try {
      $s = ConvertFrom-JsonText (Read-TextFile $SessionsStateFile)
      if ($s -is [Collections.IDictionary] -and $s.Contains('files') -and $s['files'] -is [Collections.IDictionary] -and $s.Contains('sent') -and $s['sent'] -is [Collections.IDictionary]) { return $s }
      Write-SessionLog 'sessions-state.json has an unknown shape - starting over'
    } catch { Write-SessionLog "sessions-state.json unreadable ($($_.Exception.Message)) - starting over" }
  }
  return [ordered]@{ version = 1; files = [ordered]@{}; sent = [ordered]@{}; lastSweepAt = [long]0 }
}

function Save-SessionsState($s, [long]$now) {
  foreach ($p in @($s['files'].Keys)) { if ((Get-SrMtime $p) -lt $now - 45 * 86400) { $s['files'].Remove($p) } }
  $cutoff = [DateTimeOffset]::FromUnixTimeSeconds($now).UtcDateTime.AddDays(-45).ToString('yyyy-MM-dd', $SrInv)
  foreach ($k in @($s['sent'].Keys)) {
    $date = ([string]$k).Substring(([string]$k).LastIndexOf('|') + 1)
    if ([string]::CompareOrdinal($date, $cutoff) -lt 0) { $s['sent'].Remove($k) }
  }
  Write-TextFile $SessionsStateFile ($s | ConvertTo-Json -Depth 32 -Compress)
  Protect-Path $SessionsStateFile $true
}

# Main + subagent files of a session add up to one bucket. Returns key -> API bucket
# for buckets the API accepts (>= 1 model, date within the last 35 days).
function Get-SrAggregate($s, [string]$minDate, [string]$maxDate) {
  $agg = [ordered]@{}
  foreach ($fs in $s['files'].Values) {
    if (-not ($fs -is [Collections.IDictionary]) -or -not $fs.Contains('buckets') -or $null -eq $fs['buckets']) { continue }
    foreach ($key in @($fs['buckets'].Keys)) {
      $b = $fs['buckets'][$key]
      if (-not $agg.Contains($key)) { $agg[$key] = New-SrBucket }
      $a = $agg[$key]
      $a['turns'] = [long]$a['turns'] + [long]$b['turns']
      foreach ($iso in @($b['firstAt'], $b['lastAt'])) { if ($iso) { $st = Get-Stamp $iso; if ($st) { Update-SrTimes $a $st[0] } } }
      foreach ($m in @($b['models'].Keys)) {
        $row = Get-SrModelRow $a ([string]$m)
        foreach ($f in (@('requests') + $SrFields)) { if ($b['models'][$m].Contains($f)) { $row[$f] = [long]$row[$f] + [long]$b['models'][$m][$f] } }
      }
    }
  }
  $out = [ordered]@{}
  $keys = [string[]]@($agg.Keys)
  [Array]::Sort($keys, [StringComparer]::Ordinal)
  foreach ($key in $keys) {
    $a = $agg[$key]
    $parts = $key.Split('|')
    if ($parts.Count -ne 3 -or $a['models'].Count -eq 0) { continue }
    if ([string]::CompareOrdinal($parts[2], $minDate) -lt 0 -or [string]::CompareOrdinal($parts[2], $maxDate) -gt 0) { continue }
    $names = [string[]]@($a['models'].Keys)
    if ($names.Count -gt 20) {
      $names = [string[]]@($names | Sort-Object -Property @{ Expression = { [long]$a['models'][$_]['requests'] }; Descending = $true }, @{ Expression = { $_ } } | Select-Object -First 20)
    }
    [Array]::Sort($names, [StringComparer]::Ordinal)
    $models = [ordered]@{}
    foreach ($m in $names) { $models[$m] = $a['models'][$m] }
    $out[$key] = [ordered]@{ tool = $parts[0]; sessionId = $parts[1]; date = $parts[2]; firstAt = $a['firstAt']; lastAt = $a['lastAt']; turns = [long]$a['turns']; models = $models }
  }
  return $out
}

function Get-SrDigest($b) {
  $sha = [Security.Cryptography.SHA1]::Create()
  try {
    $bytes = $sha.ComputeHash($Utf8NoBom.GetBytes(($b | ConvertTo-Json -Depth 8 -Compress)))
    return ([BitConverter]::ToString($bytes).Replace('-', '').ToLowerInvariant()).Substring(0, 20)
  } finally { $sha.Dispose() }
}

# 'ok' | 'rejected' (validation error: would repeat forever) | 'fail'
function Send-SessionChunk([string]$endpoint, [string]$token, $chunk) {
  $list = New-Object Collections.ArrayList
  foreach ($b in $chunk) { [void]$list.Add($b) }
  $body = ([ordered]@{ buckets = $list } | ConvertTo-Json -Depth 8 -Compress)
  try {
    $r = Invoke-Post $endpoint $body 'application/json' @{ Authorization = "Bearer $token" } 10
  } catch {
    Write-SessionLog "POST $endpoint failed ($($_.Exception.Message))"
    return 'fail'
  }
  if ($r.Status -ge 200 -and $r.Status -lt 300) { return 'ok' }
  $detail = [string]$r.Body
  if ($detail.Length -gt 200) { $detail = $detail.Substring(0, 200) }
  Write-SessionLog "POST $endpoint failed (HTTP $($r.Status)) $detail"
  if (@(400, 413, 422) -contains $r.Status) { return 'rejected' }
  return 'fail'
}

# 0 ok, 2 failure (logged, state unsaved), 10 ok and a full sweep is due (hook mode).
function Invoke-SessionReportCore([bool]$sweep, [bool]$quiet, [bool]$dry, [string]$hookInput) {
  $token = ''; $endpoint = ''
  if (-not $dry) {
    if (-not $DashboardUrl -or -not $CognitoClientId) { Write-SessionLog "DASHBOARD_URL / COGNITO_CLIENT_ID not set (edit $CfgFile)" $quiet; return 2 }
    $token = Get-SessionAccessToken
    if (-not $token) { Write-SessionLog "no Cognito session - nothing sent (run 'cc-bedrock-local login')" $quiet; return 0 }
    $endpoint = if ($env:CC_BEDROCK_SESSION_ENDPOINT) { $env:CC_BEDROCK_SESSION_ENDPOINT } else { $DashboardUrl.TrimEnd('/') + '/api/local/sessions' }
  }
  $now = Get-EpochNow
  $today = [DateTimeOffset]::FromUnixTimeSeconds($now).UtcDateTime.Date
  $minDate = $today.AddDays(-34).ToString('yyyy-MM-dd', $SrInv)
  $maxDate = $today.AddDays(1).ToString('yyyy-MM-dd', $SrInv)
  $lock = $null
  if (-not $dry) {
    $deadline = $now + $(if ($sweep) { 300 } else { 25 })
    while ($null -eq $lock) {
      try { $lock = [IO.File]::Open("$SessionsStateFile.lock", [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
      catch {
        if ((Get-EpochNow) -gt $deadline) { Write-SessionLog 'another session-report is running - skipped' $quiet; return 2 }
        Start-Sleep -Milliseconds 200
      }
    }
  }
  try {
    $state = Read-SessionsState
    $mode = if ($sweep) { 'sweep' } else { 'hook' }
    $tp = $null
    if ($mode -ceq 'hook') {
      try { $hk = ConvertFrom-JsonText $hookInput } catch { $hk = $null }
      if ($hk -is [Collections.IDictionary] -and $hk.Contains('transcript_path') -and $hk['transcript_path'] -is [string]) { $tp = [string]$hk['transcript_path'] }
      else { $mode = 'sweep' }   # run by hand (no hook payload)
    }
    $parsed = 0; $sweepDue = $false
    if ($mode -ceq 'hook') {
      if ($tp.EndsWith('.jsonl', [StringComparison]::Ordinal) -and [IO.File]::Exists($tp)) {
        $parsed += Update-SessionFile $state $tp 'claude' $false
        $sub = Join-Path $tp.Substring(0, $tp.Length - 6) 'subagents'
        if ([IO.Directory]::Exists($sub)) {
          $subs = [string[]]@([IO.Directory]::GetFiles($sub, '*.jsonl'))
          [Array]::Sort($subs, [StringComparer]::Ordinal)
          foreach ($f in $subs) { $parsed += Update-SessionFile $state $f 'claude' $true }
        }
      }
      $lastSweep = [long]0
      if ($state.Contains('lastSweepAt') -and $state['lastSweepAt']) { $lastSweep = [long]$state['lastSweepAt'] }
      if ($now - $lastSweep -ge 600) { $sweepDue = $true; $state['lastSweepAt'] = $now }
    } else {
      $since = $now - 3 * 86400
      foreach ($f in (Get-SrFiles (Join-Path $ClaudeDir 'projects') '' $since)) {
        $isSub = [IO.Path]::GetFileName([IO.Path]::GetDirectoryName($f)) -ceq 'subagents'
        $parsed += Update-SessionFile $state $f 'claude' $isSub
      }
      foreach ($f in (Get-SrFiles (Join-Path $CodexDir 'sessions') 'rollout-' $since)) { $parsed += Update-SessionFile $state $f 'codex' $false }
      $state['lastSweepAt'] = $now
    }
    $buckets = Get-SrAggregate $state $minDate $maxDate
    $dirty = New-Object Collections.ArrayList
    $digests = @{}
    foreach ($key in @($buckets.Keys)) {
      $dg = Get-SrDigest $buckets[$key]
      $digests[$key] = $dg
      if (-not ($state['sent'].Contains($key) -and [string]$state['sent'][$key] -ceq $dg)) { [void]$dirty.Add($buckets[$key]) }
    }
    if ($dry) {
      Out ([ordered]@{ buckets = $dirty } | ConvertTo-Json -Depth 8 -Compress)
      return 0
    }
    $rejected = 0
    for ($i = 0; $i -lt $dirty.Count; $i += 100) {
      $chunk = $dirty.GetRange($i, [Math]::Min(100, $dirty.Count - $i))
      $res = Send-SessionChunk $endpoint $token $chunk
      if ($res -ceq 'fail') { return 2 }   # state not saved: the same buckets are sent next time
      if ($res -ceq 'rejected') { $rejected += $chunk.Count }
    }
    foreach ($b in $dirty) { $k = [string]$b['tool'] + '|' + [string]$b['sessionId'] + '|' + [string]$b['date']; $state['sent'][$k] = $digests[$k] }
    Save-SessionsState $state $now
    if (-not $quiet) {
      $msg = "session-report: $parsed file(s) parsed, $($dirty.Count - $rejected) session bucket(s) sent"
      if ($rejected) { $msg += ", $rejected rejected (see $SessionLogFile)" }
      Out $msg
    }
    if ($sweepDue) { return 10 }
    return 0
  } finally {
    if ($lock) { $lock.Dispose() }
  }
}

function Invoke-SessionReport([string[]]$argv) {
  $sweep = $false; $quiet = $false; $dry = $false
  foreach ($a in $argv) {
    switch -CaseSensitive ($a) {
      '--sweep' { $sweep = $true }
      '--quiet' { $quiet = $true }
      '--dry-run' { $dry = $true }   # hidden (tests): print the buckets it would send; no POST, no state save
      default { if ($argv -ccontains '--quiet') { exit 0 }; Die 'usage: cc-bedrock-local session-report [--sweep] [--quiet]' }
    }
  }
  if (-not (Test-SessionReportEnabled)) { exit 0 }
  # Stop hook payload ({"session_id","transcript_path",...}) on stdin.
  $hookInput = ''
  if (-not $sweep) { try { if ([Console]::IsInputRedirected) { $hookInput = [Console]::In.ReadToEnd() } } catch { } }
  $code = 2
  try {
    $code = Invoke-SessionReportCore $sweep $quiet $dry $hookInput
  } catch {
    Write-SessionLog "session-report failed: $($_.Exception.Message)" $quiet
  }
  if ($code -eq 10) { Start-SessionSweep; $code = 0 }
  # Hook / background mode: never fail Claude Code.
  if ($quiet -or $code -eq 0) { exit 0 }
  exit 1
}

# --- set-model / models / status / config -------------------
function Invoke-SetModel([string[]]$argv) {
  if (-not $argv -or -not $argv[0]) { Die 'usage: set-model <key>=<value>  OR  set-model <key> <value>' }
  if ($argv[0].Contains('=')) { $key, $val = $argv[0].Split('=', 2) } else { $key = $argv[0]; $val = if ($argv.Count -gt 1) { $argv[1] } else { '' }; if (-not $val) { Die 'value missing' } }
  switch -Regex ($key) {
    '^(sonnet|default|ANTHROPIC_DEFAULT_SONNET_MODEL)$' { $key = 'ANTHROPIC_DEFAULT_SONNET_MODEL'; break }
    '^(opus|ANTHROPIC_DEFAULT_OPUS_MODEL)$' { $key = 'ANTHROPIC_DEFAULT_OPUS_MODEL'; break }
    '^(haiku|fast|small|ANTHROPIC_DEFAULT_HAIKU_MODEL|ANTHROPIC_SMALL_FAST_MODEL)$' { $key = 'ANTHROPIC_DEFAULT_HAIKU_MODEL'; break }
    '^(subagent|CLAUDE_CODE_SUBAGENT_MODEL)$' { $key = 'CLAUDE_CODE_SUBAGENT_MODEL'; break }
    '^(pin|model|ANTHROPIC_MODEL)$' { $key = 'ANTHROPIC_MODEL'; break }
    '^(codex|gpt|CODEX_MODEL)$' { $key = 'CODEX_MODEL'; break }
    default { Die "unknown model key: $key (use sonnet|opus|haiku|subagent|pin|codex)" }
  }
  Set-ConfigValue $key $val
  Out "OK $key=$val (saved to $CfgFile)"
  $Models[$key] = $val
  if (Test-ClientsConfigured) {
    Invoke-Setup $true
    Out 'OK claude/codex settings updated'
    # With a mantle grant the default codex model comes from the grant (mantle IDs
    # differ from bedrock-runtime ones); CODEX_MODEL drives the metered runtime path.
    $applied = Get-CodexDefault
    if ($key -ceq 'CODEX_MODEL' -and $applied[0] -ceq 'amazon-bedrock') {
      Out "  codex default is mantle ($($applied[1]), from your grant); CODEX_MODEL applies to codex -p runtime"
    }
  }
  if ($OnWindows -and (Test-Path $DesktopPolicyKey) -and (Get-ItemProperty -Path $DesktopPolicyKey -Name inferenceModels -ErrorAction SilentlyContinue)) {
    Out '  Claude Desktop keeps its model list until you re-run setup-desktop'
  }
}

function Invoke-Models {
  Out "Current model env (from $CfgFile or defaults):"
  Out "  ANTHROPIC_DEFAULT_SONNET_MODEL = $($Models['ANTHROPIC_DEFAULT_SONNET_MODEL'])   # /model Default + Sonnet"
  Out "  ANTHROPIC_DEFAULT_OPUS_MODEL   = $($Models['ANTHROPIC_DEFAULT_OPUS_MODEL'])   # /model Opus"
  Out "  ANTHROPIC_DEFAULT_HAIKU_MODEL  = $($Models['ANTHROPIC_DEFAULT_HAIKU_MODEL'])   # /model Haiku + background"
  Out "  CLAUDE_CODE_SUBAGENT_MODEL     = $($Models['CLAUDE_CODE_SUBAGENT_MODEL'])   # subagent dispatch"
  Out "  ANTHROPIC_MODEL                = $(if ($Models['ANTHROPIC_MODEL']) { $Models['ANTHROPIC_MODEL'] } else { '(unset - picker shows Default)' })"
  Out "  CODEX_MODEL                    = $($Models['CODEX_MODEL'])   # codex (OpenAI on Bedrock)"
  Out ''
  Out 'Examples:'
  Out "  cc-bedrock-local set-model sonnet global.anthropic.claude-sonnet-5-5"
  Out "  cc-bedrock-local set-model opus   global.anthropic.claude-opus-5-5"
  Out "  cc-bedrock-local set-model codex  global.openai.gpt-6-luna"
  Out ''
  Out 'Aliases: sonnet|default | opus | haiku|fast|small | subagent | pin|model | codex|gpt'
}

function Invoke-Status {
  $s = Read-State
  if (-not $s) { Out "no session - run 'cc-bedrock-local login'"; exit 1 }
  $c = if ($s.Contains('credentials')) { $s['credentials'] } else { @{} }
  $limit = if ($s.Contains('limitStatus') -and $s['limitStatus']) { $s['limitStatus'] } else { @{} }
  $exp = if ($c.Contains('expiration')) { Format-Iso $c['expiration'] } else { '-' }
  Out "email         : $(if ($script:Email) { $script:Email } else { '(unset)' })"
  Out "role_arn      : $(if ($s.Contains('roleArn')) { $s['roleArn'] } else { '-' })"
  Out "region        : $(if ($s.Contains('region')) { $s['region'] } else { '-' })"
  Out "expiration    : $exp"
  if ($exp -ne '-') {
    $left = (ConvertTo-Epoch $exp) - (Get-EpochNow)
    Out "remaining     : $([TimeSpan]::FromSeconds([Math]::Max(0, $left)))"
  }
  $deny = $limit.Contains('denyActive') -and $limit['denyActive']
  Out "deny active   : $deny"
  if ($deny) {
    Out "  reason      : $($limit['denyReason'])"
    Out "  reset_at    : $($limit['resetAt'])"
  }
  $note = Get-MantleNote
  $where = if ((Get-CodexDefault)[0] -ceq 'amazon-bedrock') { 'codex default (runtime: codex -p runtime)' } else { 'codex -p mantle only (codex default stays bedrock-runtime)' }
  Out "mantle        : $(if ($note) { "enabled, $where - NOT counted in usage or budget" } else { 'off (available only while your cost is unlimited)' })"
  if (Test-Path -LiteralPath $TokenCache) {
    $t = ConvertFrom-JsonText (Read-TextFile $TokenCache)
    $age = (Get-EpochNow) - [long]$t['obtainedAt']
    Out "cognito cache : present (age $([Math]::Floor($age / 60))m)"
  } else {
    Out 'cognito cache : (absent - next refresh will prompt for password)'
  }
  if ($OnWindows) {
    $task = $null
    try { $task = Get-ScheduledTask -TaskName $KeepAliveTask -ErrorAction Stop } catch { }
    Out "keep-alive    : $(if ($task) { "scheduled task $($task.State)" } elseif (Test-KeepAliveEnabled) { 'not installed (run: cc-bedrock-local setup)' } else { 'off (KEEPALIVE=off)' })"
  }
}

function Invoke-Config {
  Out "config file        : $CfgFile"
  Out "state file         : $StateFile"
  Out "cognito token cache: $TokenCache"
  Out "DASHBOARD_URL      : $(if ($DashboardUrl) { $DashboardUrl } else { '(unset)' })"
  Out "COGNITO_REGION     : $CognitoRegion"
  Out "COGNITO_USER_POOL  : $(Cfg 'COGNITO_USER_POOL_ID' '(unset)')"
  Out "COGNITO_CLIENT_ID  : $(if ($CognitoClientId) { $CognitoClientId } else { '(unset)' })"
  Out "EMAIL              : $(if ($script:Email) { $script:Email } else { '(unset)' })"
  Out "AWS_PROFILE        : $AwsProfileName"
  Out "AWS_REGION         : $AwsRegion"
  Out "claude settings    : $ClaudeSettingsFile"
  Out "codex config       : $CodexConfigFile"
  Out "SESSION_REPORT     : $SessionReport (state $SessionsStateFile, log $SessionLogFile)"
}

function Invoke-Usage {
  Out @"
cc-bedrock-local (Windows) - Local Governance Mode CLI (ADR-006)

Subcommands:
  login                 prompt password (email from config) -> login + STS issue
  refresh               silent only - uses cached refresh token
  credential-process    AWS SDK credential_process hook (wired into ~/.aws/config)
  logout                clear cached session
  change-email          prompt new email + password, update config, re-login
  status                session state + limit/deny state
  setup                 Claude Code (CLI + Claude Desktop Code tab) and Codex (CLI + app) -> Bedrock
  unsetup               remove those settings again
  setup-desktop         opt-in: Claude Desktop Cowork/Chat -> Bedrock (third-party mode, needs AWS CLI v2)
  unsetup-desktop       remove the Claude Desktop Bedrock policy values
  set-model KEY=VAL     change model (sonnet|opus|haiku|subagent|pin|codex)
  models                show current model env
  config                print config / file paths
  session-report [--sweep] [--quiet]
                        report session turns/tokens from local Claude Code transcripts and
                        Codex rollouts (insight only; run by the Stop hook 'setup' installs;
                        SESSION_REPORT=off in the config disables it)
  keepalive [--sign-in] renew credentials ahead of expiry, or show the sign-in window when
                        the sign-in expired (run by the task 'setup' installs; KEEPALIVE=off
                        in the config disables it)

Config file: $CfgFile
"@
}

# --- dispatch -----------------------------------------------
$sub = if ($args.Count) { [string]$args[0] } else { '' }
$rest = if ($args.Count -gt 1) { [string[]]$args[1..($args.Count - 1)] } else { @() }
switch ($sub) {
  'login' { Invoke-Login }
  'refresh' { Invoke-Refresh }
  { $_ -in 'credential-process', 'credential_process' } { Invoke-CredentialProcess }
  'logout' { Invoke-Logout }
  { $_ -in 'change-email', 'change_email' } { Invoke-ChangeEmail }
  'status' { Invoke-Status }
  'setup' { Invoke-Setup }
  'unsetup' { Invoke-Unsetup }
  'setup-desktop' { Invoke-SetupDesktop }
  'unsetup-desktop' { Invoke-UnsetupDesktop }
  { $_ -in 'set-model', 'set_model' } { Invoke-SetModel $rest }
  { $_ -in 'session-report', 'session_report' } { Invoke-SessionReport $rest }
  'keepalive' { Invoke-KeepAlive $rest }
  'post-issue' { Invoke-PostIssue }
  'models' { Invoke-Models }
  'config' { Invoke-Config }
  { $_ -in '', '-h', '--help', 'help' } { Invoke-Usage }
  default { Die "unknown subcommand: $sub" }
}
exit 0
