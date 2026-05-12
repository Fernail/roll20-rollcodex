param(
  [string]$OutputDirectory = "dist"
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$manifestPath = Join-Path $root "manifest.json"
$manifest = Get-Content -Raw -Path $manifestPath | ConvertFrom-Json
$version = $manifest.version
$zipName = "rollcodex-roll20-v$version.zip"
$outputPath = Join-Path $root $OutputDirectory
$zipPath = Join-Path $outputPath $zipName

New-Item -ItemType Directory -Force -Path $outputPath | Out-Null
if (Test-Path $zipPath) { Remove-Item -Force $zipPath }

$files = @(
  "manifest.json",
  "background.js",
  "roll20-content.js",
  "rollcodex-content.js",
  "README.md"
)

$missing = $files | Where-Object { -not (Test-Path (Join-Path $root $_)) }
if ($missing.Count -gt 0) {
  throw "Fichiers manquants: $($missing -join ', ')"
}

$resolvedFiles = $files | ForEach-Object { Join-Path $root $_ }
Compress-Archive -Path $resolvedFiles -DestinationPath $zipPath
Write-Host "Package Chrome pret: $zipPath"
