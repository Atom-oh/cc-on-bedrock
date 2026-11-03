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
  Move-Item -LiteralPath $tmp -Destination $path -Force
}

function Read-TextFile([string]$path) {
  if (Test-Path -LiteralPath $path) { return [IO.File]::ReadAllText($path) }
  return ''
}

# Owner-only access: Windows ACL (inheritable on the directory) or chmod elsewhere.
function Protect-Path([string]$path) {
  if (-not (Test-Path -LiteralPath $path)) { return }
  if ($OnWindows) {
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $grant = if ((Get-Item -LiteralPath $path) -is [IO.DirectoryInfo]) { "*${sid}:(OI)(CI)F" } else { "*${sid}:F" }
    & icacls.exe $path /inheritance:r /grant:r $grant 2>&1 | Out-Null
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
  if ($v -is [datetime]) { return $v.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ') }
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
  ANTHROPIC_MODEL                = Cfg 'ANTHROPIC_MODEL' 'opusplan'
  ANTHROPIC_DEFAULT_SONNET_MODEL = Cfg 'ANTHROPIC_DEFAULT_SONNET_MODEL' 'global.anthropic.claude-sonnet-5'
  ANTHROPIC_DEFAULT_OPUS_MODEL   = Cfg 'ANTHROPIC_DEFAULT_OPUS_MODEL' 'global.anthropic.claude-opus-4-8'
  ANTHROPIC_DEFAULT_HAIKU_MODEL  = Cfg 'ANTHROPIC_DEFAULT_HAIKU_MODEL' (Cfg 'ANTHROPIC_SMALL_FAST_MODEL' 'global.anthropic.claude-haiku-4-5-20251001-v1:0')
  CLAUDE_CODE_SUBAGENT_MODEL     = Cfg 'CLAUDE_CODE_SUBAGENT_MODEL' 'global.anthropic.claude-sonnet-5'
  CODEX_MODEL                    = Cfg 'CODEX_MODEL' 'global.openai.gpt-6.1-sol'
}

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
function Invoke-Post([string]$uri, [string]$body, [string]$contentType, [hashtable]$headers = @{}) {
  if ($PSVersionTable.PSVersion.Major -lt 6) { Add-Type -AssemblyName System.Net.Http }
  $client = New-Object System.Net.Http.HttpClient
  $client.Timeout = [TimeSpan]::FromSeconds(30)
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

function Save-Tokens([string]$access, [string]$refresh) {
  $json = ConvertTo-JsonText ([ordered]@{ accessToken = $access; refreshToken = $refresh; obtainedAt = (Get-EpochNow) })
  Write-TextFile $TokenCache $json
  Protect-Path $TokenCache
}

function Get-CachedRefreshToken {
  if (-not (Test-Path -LiteralPath $TokenCache)) { return '' }
  try {
    $t = ConvertFrom-JsonText (Read-TextFile $TokenCache)
    if ($t -and $t.Contains('refreshToken') -and $t['refreshToken']) { return [string]$t['refreshToken'] }
  } catch { }
  return ''
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
  Write-TextFile $StateFile $raw
  Protect-Path $StateFile
}

function Get-StateExpiryEpoch {
  $s = Read-State
  if (-not $s -or -not $s.Contains('credentials')) { return 0 }
  return ConvertTo-Epoch (Format-Iso $s['credentials']['expiration'])
}

# --- credential command line --------------------------------
# Run by the AWS SDK (cmd.exe /C on Windows) and by Claude Code's
# awsCredentialExport. Forward slashes keep it valid in cmd, Git Bash and
# PowerShell alike; the script path is quoted because profiles may contain spaces.
function Get-SelfPath {
  $p = $PSCommandPath
  if ($OnWindows) { $p = $p -replace '\\', '/' }
  return $p
}
function Get-CredentialCommand {
  $self = Get-SelfPath
  if ($OnWindows) { return "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$self`" credential-process" }
  return "pwsh -NoProfile -NonInteractive -File `"$self`" credential-process"
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
    if ($cleaned -ne $c) { Write-TextFile $AwsCredsFile $cleaned }
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
}

function Invoke-Refresh {
  Require-Config
  $refresh = Get-CachedRefreshToken
  if (-not $refresh) { Say "no cached session - run 'cc-bedrock-local login'"; exit 2 }
  try {
    $auth = Invoke-Cognito @{ REFRESH_TOKEN = $refresh } 'REFRESH_TOKEN_AUTH'
  } catch { Say 'refresh token expired or rejected - re-login required'; exit 2 }
  # Cognito does not rotate the refresh token by default.
  Save-Tokens $auth['AccessToken'] $refresh
  Out 'OK silent refresh OK'
  $raw = Request-Sts $auth['AccessToken']
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
    if ($state -and $state.Contains('credentials') -and ((Get-StateExpiryEpoch) - (Get-EpochNow) -gt 300)) {
      Write-CredentialsJson $state
      return
    }
    $refresh = Get-CachedRefreshToken
    if (-not $refresh) { Say "no refresh token cached - run 'cc-bedrock-local login'"; exit 1 }
    try {
      $auth = Invoke-Cognito @{ REFRESH_TOKEN = $refresh } 'REFRESH_TOKEN_AUTH'
    } catch { Say "Cognito refresh token expired (30-day window) - run 'cc-bedrock-local login'"; exit 1 }
    Save-Tokens $auth['AccessToken'] $refresh
    $raw = Request-Sts $auth['AccessToken']
    if (-not $raw) { Say "dashboard refused STS issue (token limit Deny active? check 'cc-bedrock-local status')"; exit 1 }
    Save-State $raw
    Sync-CodexMantle
    Write-CredentialsJson (ConvertFrom-JsonText $raw)
  } catch {
    Say $_.Exception.Message
    exit 1
  }
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
  Write-ClaudeSettings $s
}

function Remove-ClaudeSettings {
  if (-not (Test-Path -LiteralPath $ClaudeSettingsFile)) { return }
  $s = Read-ClaudeSettings
  if ($s.Contains('env') -and $s['env']) {
    foreach ($k in $ClaudeManagedEnv) { if ($s['env'].Contains($k)) { $s['env'].Remove($k) } }
    if ($s['env'].Count -eq 0) { $s.Remove('env') }
  }
  if ($s.Contains('awsCredentialExport') -and ([string]$s['awsCredentialExport']).EndsWith(' credential-process')) { $s.Remove('awsCredentialExport') }
  if ($s.Contains('permissions') -and $s['permissions'] -and $s['permissions'].Contains('deny') -and $s['permissions']['deny']) {
    $deny = $s['permissions']['deny']
    while ($deny -contains $ClaudeCredRule) { $deny.Remove($ClaudeCredRule) }
    if ($deny.Count -eq 0) { $s['permissions'].Remove('deny') }
    if ($s['permissions'].Count -eq 0) { $s.Remove('permissions') }
  }
  Write-ClaudeSettings $s
}

function Test-ClientsConfigured {
  if (-not (Test-Path -LiteralPath $ClaudeSettingsFile)) { return $false }
  try {
    $s = ConvertFrom-JsonText (Read-TextFile $ClaudeSettingsFile)
    return [bool]($s -and $s.Contains('awsCredentialExport') -and ([string]$s['awsCredentialExport']).EndsWith(' credential-process'))
  } catch { return $false }
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
  $mantle = @{}
  $st = Read-State
  if ($st -and $st.Contains('mantle') -and $st['mantle']) { $mantle = $st['mantle'] }
  $mOurs = (-not (Test-Path -LiteralPath $mPath)) -or (Read-TextFile $mPath).Contains($CodexMark)

  $lines = New-Object Collections.Generic.List[string]
  $text = Read-TextFile $CodexConfigFile
  if ($text) {
    $lines.AddRange([string[]]($text -split "`r?`n"))
    if ($lines[$lines.Count - 1] -eq '') { $lines.RemoveAt($lines.Count - 1) }
  }
  $topKey = '^\s*(model_provider|model|web_search)\s*='
  $out = New-Object Collections.Generic.List[string]
  $inTop = $true; $inOurs = $false
  foreach ($line in $lines) {
    if ($line.Trim().StartsWith('[')) {
      $inTop = $false
      $inOurs = @($table, $perms, $permsFs, $mProfile) -contains $line.Split('#')[0].Trim()
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
  if ($mode -eq 'add') {
    $head = New-Object Collections.Generic.List[string]
    $head.Add("model_provider = `"amazon-bedrock-runtime`"  $CodexMark")
    $head.Add("model = $(& $q $Models['CODEX_MODEL'])  $CodexMark")
    $head.Add("web_search = `"disabled`"  $CodexMark")
    $tail = New-Object Collections.Generic.List[string]
    $tail.AddRange([string[]]@('', "$table  $CodexMark", "profile = $(& $q $AwsProfileName)", "region = $(& $q $AwsRegion)"))
    # Keep commands Codex runs away from the cached refresh token and STS keys
    # (permission profile on :workspace denying the CLI dir; enforced by the
    # sandbox). A user who chose their own sandbox keeps it and gets a warning.
    $own = @($clean | Where-Object { $_ -cmatch '^\s*(default_permissions|sandbox_mode)\s*=' -or $_.Split('#')[0].Trim() -eq '[sandbox_workspace_write]' })
    if ($own.Count) {
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
  $wantMantle = ($mode -eq 'add') -and $mantle.Contains('enabled') -and $mantle['enabled'] -and $mantle.Contains('projectId') -and $mantle['projectId']
  if ($wantMantle -and $mOurs) {
    $mModel = if ($mantle.Contains('model') -and $mantle['model']) { $mantle['model'] } else { 'openai.gpt-6.1-sol' }
    $mRegion = if ($mantle.Contains('region') -and $mantle['region']) { $mantle['region'] } else { 'us-east-1' }
    # The em dash matches the bash CLI byte for byte (kept out of this ASCII file).
    $m = @("$CodexMark $([char]0x2014) bedrock-mantle (web search). NOT counted in usage or budget;",
      '# granted only while your cost is unlimited. Use: codex -p mantle',
      'model_provider = "amazon-bedrock"', "model = $(& $q $mModel)", 'web_search = "live"',
      '', $mAws, "profile = $(& $q $AwsProfileName)", "region = $(& $q $mRegion)",
      # IAM allows only the user's own project: without the header the call is denied.
      '', $mHdr, "OpenAI-Project = $(& $q $mantle['projectId'])")
    Write-TextFile $mPath (($m -join "`n") + "`n")
  } elseif ($wantMantle -and -not $quiet) {
    Say "$mPath is your own file - not adding the mantle profile"
  } elseif ($mOurs -and (Test-Path -LiteralPath $mPath)) {
    Remove-Item -LiteralPath $mPath -Force
  }
  $body = ($clean -join "`n")
  if ($clean.Count) { $body += "`n" }
  Write-TextFile $CodexConfigFile $body
}

function Get-MantleNote {
  $s = Read-State
  if ($s -and $s.Contains('mantle') -and $s['mantle'] -and $s['mantle']['enabled']) {
    $m = $s['mantle']
    return "mantle (codex -p mantle, $($m['model']), $($m['region'])): enabled - web search; NOT counted in usage or budget; available while your cost is unlimited"
  }
  return ''
}

# After new credentials keep the Codex mantle profile in step with the grant.
function Sync-CodexMantle {
  if (-not (Test-ClientsConfigured)) { return }
  try { Set-CodexConfig 'add' $true } catch { Say "could not update $CodexConfigFile" }
}

function Invoke-Setup([bool]$quietOutput = $false) {
  Require-Config
  Install-AwsProfile
  Set-ClaudeSettings
  Set-CodexConfig 'add'
  if (-not $quietOutput) {
    Out "OK claude -> Bedrock (${ClaudeSettingsFile}: env + awsCredentialExport) - Claude Code CLI and the Claude Desktop Code tab"
    Out "OK codex  -> Bedrock (${CodexConfigFile}: amazon-bedrock-runtime, profile=$AwsProfileName, model=$($Models['CODEX_MODEL'])) - Codex CLI and the Codex app"
    Out '  restart Claude Desktop / the Codex app so they reload their settings'
    $note = Get-MantleNote
    if ($note) { Out "! $note (CLI only)" }
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
}

function Invoke-Unsetup {
  Remove-ClaudeSettings
  Set-CodexConfig 'remove'
  Out "OK removed Bedrock settings from $ClaudeSettingsFile and $CodexConfigFile"
}

# --- Claude Desktop third-party mode (Cowork / Chat) --------
# Opt-in: inferenceProvider=bedrock switches the whole app from claude.ai sign-in
# to Bedrock. Credentials come from the named profile (credential_process above);
# the app needs AWS CLI v2 to read it. Values are REG_SZ directly under the key.
$DesktopValueNames = @('inferenceProvider', 'inferenceBedrockRegion', 'inferenceBedrockProfile', 'inferenceBedrockAwsCliPath', 'inferenceModels')

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
  return $v
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
  try {
    if (-not (Test-Path $DesktopPolicyKey)) { New-Item -Path $DesktopPolicyKey -Force | Out-Null }
    foreach ($k in $vals.Keys) { New-ItemProperty -Path $DesktopPolicyKey -Name $k -Value $vals[$k] -PropertyType String -Force | Out-Null }
    Out "OK Claude Desktop -> Bedrock ($($DesktopPolicyKey -replace ':', ''): inferenceProvider=bedrock, profile=$AwsProfileName)"
    Out '  quit and reopen Claude Desktop; undo: cc-bedrock-local unsetup-desktop'
  } catch {
    # HKCU\SOFTWARE\Policies is often admin-only; hand over a .reg file instead.
    $lines = @('Windows Registry Editor Version 5.00', '', '[HKEY_CURRENT_USER\SOFTWARE\Policies\Claude]')
    foreach ($k in $vals.Keys) { $lines += ('"{0}"="{1}"' -f $k, ($vals[$k].Replace('\', '\\').Replace('"', '\"'))) }
    [IO.File]::WriteAllText($DesktopRegFile, (($lines -join "`r`n") + "`r`n"), [Text.Encoding]::Unicode)
    Say "no write access to $($DesktopPolicyKey -replace ':', '') ($($_.Exception.Message))"
    Out "  wrote $DesktopRegFile - import it from an elevated prompt (reg import `"$DesktopRegFile`") or ask IT to deploy it, then reopen Claude Desktop"
  }
}

function Invoke-UnsetupDesktop {
  if (-not $OnWindows) { Die 'unsetup-desktop is Windows only' }
  if (Test-Path $DesktopPolicyKey) {
    foreach ($k in $DesktopValueNames) { Remove-ItemProperty -Path $DesktopPolicyKey -Name $k -ErrorAction SilentlyContinue }
  }
  Out "OK removed Claude Desktop Bedrock policy values (reopen Claude Desktop)"
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
  Out "  cc-bedrock-local set-model sonnet global.anthropic.claude-sonnet-5"
  Out "  cc-bedrock-local set-model opus   global.anthropic.claude-opus-4-8"
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
  Out "mantle        : $(if ($note) { 'enabled (codex -p mantle) - NOT counted in usage or budget' } else { 'off (available only while your cost is unlimited)' })"
  if (Test-Path -LiteralPath $TokenCache) {
    $t = ConvertFrom-JsonText (Read-TextFile $TokenCache)
    $age = (Get-EpochNow) - [long]$t['obtainedAt']
    Out "cognito cache : present (age $([Math]::Floor($age / 60))m)"
  } else {
    Out 'cognito cache : (absent - next refresh will prompt for password)'
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
  'models' { Invoke-Models }
  'config' { Invoke-Config }
  { $_ -in '', '-h', '--help', 'help' } { Invoke-Usage }
  default { Die "unknown subcommand: $sub" }
}
exit 0
