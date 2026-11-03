<#
  Codex desktop, rerouted.

  Starts the Responses->Chat bridge, then launches the patched app copy with a
  private CODEX_HOME.

  Usage:
    .\run.ps1 -Provider nvidia
    .\run.ps1 -Provider nvidia -Larp        # picker shows OpenAI names, wire runs NVIDIA
    .\run.ps1 -Provider nvidia -Combined    # picker shows NVIDIA + OpenCode Zen side by side
    .\run.ps1 -Provider nvidia -ChatName "roblox-mcp"
    .\run.ps1 -Provider opencode
    .\run.ps1 -Provider opencode -NoApp      # bridge only, for `codex exec`

  The key comes from, in order: -ApiKey, the provider's env var, secrets.json.
  OpenCode's key is auto-read from ~/.local/share/opencode/auth.json if secrets.json is empty.
#>

[CmdletBinding()]
param(
  [ValidateSet("opencode", "nvidia")]
  [string]$Provider = "opencode",

  [string]$ApiKey,

  [int]$Port = 8787,

  [switch]$Larp,

  [switch]$Combined,

  [switch]$NoApp,

  [string]$ChatName
)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$providers = Get-Content (Join-Path $root "providers.json") -Raw | ConvertFrom-Json
$preset = $providers.$Provider
if (-not $preset) { throw "unknown provider '$Provider'" }

if (-not $ApiKey) { $ApiKey = [Environment]::GetEnvironmentVariable($preset.apiKeyEnv) }
if (-not $ApiKey) {
  $secretsPath = Join-Path $root "secrets.json"
  if (Test-Path $secretsPath) {
    $secrets = Get-Content $secretsPath -Raw | ConvertFrom-Json
    $ApiKey = $secrets.$Provider
  }
}
if (-not $ApiKey) {
  # OpenCode's real key lives in ~/.local/share/opencode/auth.json; secrets.json
  # deliberately leaves it empty so it never gets committed.
  if ($Provider -eq "opencode") {
    $authPath = Join-Path $env:USERPROFILE ".local/share/opencode/auth.json"
    if (Test-Path $authPath) {
      $auth = Get-Content $authPath -Raw | ConvertFrom-Json
      if ($auth.opencode.key) { $ApiKey = $auth.opencode.key }
    }
  }
  if (-not $ApiKey) {
    Write-Warning "no API key for $($preset.label); upstream calls will 401. Pass -ApiKey or set $($preset.apiKeyEnv)."
  }
}

# --- adapter env ---
$env:PORT = "$Port"
$env:HOST = "127.0.0.1"
$env:UPSTREAM_BASE_URL = $preset.upstreamBaseUrl
$env:UPSTREAM_API_KEY = $ApiKey

$catalogSource = Join-Path $root $(if ($Larp) { "catalogs\larp.json" } elseif ($Combined) { "catalogs\combined.json" } else { "catalogs\nvidia.json" })
$catalogPath = Join-Path $root "codex-home\model-catalog.json"
$configPath = Join-Path $root "codex-home\config.toml"
if (-not (Test-Path $catalogSource)) { throw "catalog missing at $catalogSource" }

$defaultModel = $preset.model
$modelMap = @{ "*" = $preset.model }

if ($Larp) {
  $larpSpec = Get-Content (Join-Path $root "larp.json") -Raw | ConvertFrom-Json
  $larpMap = Get-Content (Join-Path $root "catalogs\larp-map.json") -Raw | ConvertFrom-Json
  foreach ($p in $larpMap.PSObject.Properties) { $modelMap[$p.Name] = $p.Value }
  if ($larpSpec.default) { $defaultModel = $larpSpec.default }
} elseif ($Combined) {
  $catalog = Get-Content $catalogSource -Raw | ConvertFrom-Json
  $zenBase = $providers.opencode.upstreamBaseUrl
  foreach ($m in $catalog.models) {
    if ($m._zen -eq $true) {
      # Zen models route to the OpenCode Zen base, not the default upstream.
      $modelMap[$m.slug] = @{ base = $zenBase; model = $m.slug }
    } else {
      $modelMap[$m.slug] = $m.slug
    }
  }
  if ($defaultModel -notin $catalog.models.slug) { $defaultModel = $catalog.models[0].slug }
} else {
  $catalog = Get-Content $catalogSource -Raw | ConvertFrom-Json
  foreach ($m in $catalog.models) { $modelMap[$m.slug] = $m.slug }
}
Copy-Item $catalogSource $catalogPath -Force

# The app reads model + catalog path from config, so both follow the mode.
$configText = Get-Content $configPath -Raw
$configText = [regex]::Replace($configText, '(?m)^model = ".*"$', ('model = "' + $defaultModel + '"'))
$configText = [regex]::Replace(
  $configText,
  '(?m)^model_catalog_json = ".*"$',
  ('model_catalog_json = "' + $catalogPath.Replace('\', '\\') + '"')
)
[System.IO.File]::WriteAllText($configPath, $configText)

$env:UPSTREAM_MODEL_MAP = ($modelMap | ConvertTo-Json -Compress)

# --- start the bridge ---
$adapter = Join-Path $root "adapter\responses-adapter.mjs"
$adapterLog = Join-Path $root "adapter\adapter.log"
$adapterProc = Start-Process -FilePath "node" -ArgumentList "`"$adapter`"" `
  -WorkingDirectory $root -WindowStyle Hidden -PassThru `
  -RedirectStandardOutput $adapterLog -RedirectStandardError "$adapterLog.err"

# Wait for the bridge to answer before the app tries its first turn.
$ready = $false
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Milliseconds 250
  try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 2
    if ($health.ok) { $ready = $true; break }
  } catch { }
}
if (-not $ready) {
  Stop-Process -Id $adapterProc.Id -Force -ErrorAction SilentlyContinue
  throw "bridge did not come up on port $Port; see $adapterLog"
}

Write-Host "bridge: http://127.0.0.1:$Port  ->  $($preset.upstreamBaseUrl)  ($defaultModel)"
Write-Host "health: key=$(if ($ApiKey) { 'set' } else { 'MISSING' })"

try {
  if ($NoApp) {
    Write-Host "bridge-only mode. Ctrl+C to stop."
    Wait-Process -Id $adapterProc.Id
  } else {
    $appDir = Join-Path $root "CodexApp"
    $exe = Join-Path $appDir "ChatGPT.exe"
    if (-not (Test-Path $exe)) { throw "app copy missing at $exe" }

    # Pre-create a named chat thread so the app opens with it already titled.
    if ($ChatName) {
      $threadId = [guid]::NewGuid().ToString("N")
      $nowSec = [int64]([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())
      $cwd = (Get-Location).Path
      $model = $defaultModel
      $stateDb = Join-Path $root "codex-home\state_5.sqlite"
      $sqlFile = Join-Path $root ".tmp\preinsert.sql"

      # Escape backslashes for JavaScript string literals.
      $jsStateDb = $stateDb -replace '\\', '\\\\'
      $jsSqlFile = $sqlFile -replace '\\', '\\\\'

      $escapedName = $ChatName -replace "'", "''"
      $escapedCwd = $cwd -replace "'", "''"
      $sql = "INSERT INTO threads (id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, sandbox_policy, approval_mode, model, reasoning_effort, history_mode, name, first_user_message, preview) VALUES ('$threadId', '', $nowSec, $nowSec, 'user', 'bridge', '$escapedCwd', '$escapedName', 'danger-full-access', 'never', '$model', 'low', 'legacy', '$escapedName', '$escapedName', '');"
      [System.IO.File]::WriteAllText($sqlFile, $sql)

      node -e "
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const db = new DatabaseSync('$jsStateDb');
db.exec(fs.readFileSync('$jsSqlFile', 'utf8'));
db.close();
console.log('pre-created thread: $ChatName ($threadId)');
" 2>&1 | ForEach-Object { Write-Host $_ }
    }

    # Private home keeps the real ~/.codex untouched. auth.json is pre-seeded so
    # the shell starts signed in; the provider block sends turns elsewhere.
    $env:CODEX_HOME = Join-Path $root "codex-home"
    $env:BRIDGE_KEY = "local-bridge"

    Write-Host "launching $exe"
    $appProc = Start-Process -FilePath $exe -WorkingDirectory $appDir -PassThru
    Wait-Process -Id $appProc.Id
  }
} finally {
  Stop-Process -Id $adapterProc.Id -Force -ErrorAction SilentlyContinue
  Write-Host "bridge stopped."
}
