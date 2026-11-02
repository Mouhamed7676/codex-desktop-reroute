#!/usr/bin/env pwsh
<#
  Copies the parts of a real Codex home that are not chat history into the
  rerouted private home: MCP server definitions, computer-use permissions, and
  user skills.

  Usage:
    .\tools\import-extras.ps1
    .\tools\import-extras.ps1 -SourceHome C:\Users\me\.codex -DestHome .\codex-home -Force

  MCP blocks are merged textually, not parsed: TOML has no stdlib parser here and
  the config is line-oriented in practice. A block is a `[header]` line plus
  everything until the next header. Existing destination headers are left alone
  unless -Force is set.

  node_repl is deliberately skipped: it is app-managed and its paths point at the
  source home's runtime, which does not exist under the private home.
#>
[CmdletBinding()]
param(
  [string]$SourceHome = (Join-Path $env:USERPROFILE ".codex"),
  [string]$DestHome = "",
  [switch]$Force
)

$ErrorActionPreference = "Stop"
# $PSScriptRoot is not bound yet while parameter defaults are evaluated.
if (-not $DestHome) { $DestHome = Join-Path $PSScriptRoot "..\codex-home" }
$DestHome = [System.IO.Path]::GetFullPath($DestHome)
$srcCfg = Join-Path $SourceHome "config.toml"
$dstCfg = Join-Path $DestHome "config.toml"
if (-not (Test-Path $srcCfg)) { throw "source config not found: $srcCfg" }
if (-not (Test-Path $dstCfg)) { throw "destination config not found: $dstCfg (run setup first)" }

# Headers that belong to the source machine, not to the rerouted home.
$skipExact = @(
  "mcp_servers.node_repl",
  "model_providers.bridge",
  "desktop",
  "tui",
  "windows"
)
$skipPrefix = @(
  "mcp_servers.node_repl.",
  "marketplaces.",
  "plugins.",
  "model_providers."
)
$keepPrefix = @(
  "mcp_servers.",
  "computer_use."
)

function Get-TomlBlocks([string]$Path) {
  $blocks = [System.Collections.Generic.List[object]]::new()
  $current = $null
  foreach ($line in Get-Content $Path) {
    if ($line -match '^\s*\[(.+?)\]\s*$') {
      if ($current) { $blocks.Add($current) }
      $current = [pscustomobject]@{ Header = $Matches[1]; Lines = [System.Collections.Generic.List[string]]::new() }
      $current.Lines.Add($line)
    } elseif ($current) {
      $current.Lines.Add($line)
    }
  }
  if ($current) { $blocks.Add($current) }
  return $blocks
}

function Test-Wanted([string]$Header) {
  if ($skipExact -contains $Header) { return $false }
  foreach ($p in $skipPrefix) { if ($Header.StartsWith($p)) { return $false } }
  foreach ($p in $keepPrefix) { if ($Header.StartsWith($p)) { return $true } }
  return $false
}

$dstText = Get-Content $dstCfg -Raw
$existing = [regex]::Matches($dstText, '(?m)^\s*\[(.+?)\]\s*$') | ForEach-Object { $_.Groups[1].Value }
$existing = [System.Collections.Generic.HashSet[string]]::new([string[]]$existing)

$added = [System.Collections.Generic.List[string]]::new()
$skipped = [System.Collections.Generic.List[string]]::new()
$append = [System.Text.StringBuilder]::new()

foreach ($block in (Get-TomlBlocks $srcCfg)) {
  if (-not (Test-Wanted $block.Header)) { continue }
  if ($existing.Contains($block.Header) -and -not $Force) {
    $skipped.Add($block.Header)
    continue
  }
  [void]$append.AppendLine()
  foreach ($l in $block.Lines) { [void]$append.AppendLine($l) }
  $added.Add($block.Header)
}

if ($added.Count -gt 0) {
  $out = $dstText.TrimEnd() + "`r`n" + $append.ToString()
  [System.IO.File]::WriteAllText($dstCfg, $out)
}

# Skills: mirror whatever the user installed, without deleting destination-only
# entries the app provisioned itself.
$srcSkills = Join-Path $SourceHome "skills"
$dstSkills = Join-Path $DestHome "skills"
$skillCount = 0
if (Test-Path $srcSkills) {
  New-Item -ItemType Directory -Force -Path $dstSkills | Out-Null
  foreach ($entry in Get-ChildItem $srcSkills -Force) {
    $target = Join-Path $dstSkills $entry.Name
    if ($entry.PSIsContainer) {
      Copy-Item $entry.FullName $target -Recurse -Force
      $skillCount += (Get-ChildItem $entry.FullName -Recurse -File).Count
    } else {
      Copy-Item $entry.FullName $target -Force
      $skillCount++
    }
  }
}

Write-Host "mcp/permission blocks added: $(if ($added.Count) { $added -join ', ' } else { 'none' })"
if ($skipped.Count) { Write-Host "already present (use -Force to overwrite): $($skipped -join ', ')" }
Write-Host "skill files copied: $skillCount"
