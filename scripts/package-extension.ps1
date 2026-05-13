param(
  [ValidateSet("store", "dev")]
  [string]$Channel = "store",
  [string]$OutputDirectory = "dist"
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$manifestPath = Join-Path $root "manifest.json"
$manifest = Get-Content -Raw -Path $manifestPath | ConvertFrom-Json
$version = $manifest.version
$channelName = $Channel.ToLowerInvariant()
$zipName = "rollcodex-roll20-v$version-$channelName.zip"
$outputPath = Join-Path $root $OutputDirectory
$zipPath = Join-Path $outputPath $zipName
$stagingPath = Join-Path $outputPath "package-$channelName"
$unpackedPath = Join-Path $outputPath "unpacked-$channelName"
$otherChannelName = if ($channelName -eq "store") { "dev" } else { "store" }
$otherUnpackedPath = Join-Path $outputPath "unpacked-$otherChannelName"
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

New-Item -ItemType Directory -Force -Path $outputPath | Out-Null
if (Test-Path $zipPath) { Remove-Item -Force $zipPath }
if (Test-Path $stagingPath) { Remove-Item -Recurse -Force $stagingPath }
if (Test-Path $unpackedPath) { Remove-Item -Recurse -Force $unpackedPath }
if (Test-Path $otherUnpackedPath) { Remove-Item -Recurse -Force $otherUnpackedPath }
New-Item -ItemType Directory -Force -Path $stagingPath | Out-Null

$files = @(
  "manifest.json",
  "background.js",
  "roll20-content.js",
  "rollcodex-content.js"
)

$directories = @(
  "icons"
)

$missing = $files | Where-Object { -not (Test-Path (Join-Path $root $_)) }
if ($missing.Count -gt 0) {
  throw "Fichiers manquants: $($missing -join ', ')"
}

$missingDirectories = $directories | Where-Object { -not (Test-Path (Join-Path $root $_)) }
if ($missingDirectories.Count -gt 0) {
  throw "Dossiers manquants: $($missingDirectories -join ', ')"
}

foreach ($file in $files) {
  Copy-Item -Path (Join-Path $root $file) -Destination (Join-Path $stagingPath $file)
}

foreach ($directory in $directories) {
  Copy-Item -Recurse -Path (Join-Path $root $directory) -Destination (Join-Path $stagingPath $directory)
}

if ($channelName -eq "store") {
  $storeManifestPath = Join-Path $stagingPath "manifest.json"
  $storeManifest = Get-Content -Raw -Path $storeManifestPath | ConvertFrom-Json
  $storeManifest.host_permissions = @(
    "https://rollcodex.app/*",
    "https://*.supabase.co/*",
    "https://app.roll20.net/*"
  )

  foreach ($contentScript in $storeManifest.content_scripts) {
    if (@($contentScript.js) -contains "rollcodex-content.js") {
      $contentScript.matches = @("https://rollcodex.app/*")
    }
  }

  [System.IO.File]::WriteAllText($storeManifestPath, ($storeManifest | ConvertTo-Json -Depth 20), $utf8NoBom)

  $roll20ContentPath = Join-Path $stagingPath "roll20-content.js"
  $roll20Content = Get-Content -Raw -Path $roll20ContentPath
  $devBaseUrl = "const ROLLCODEX_APP_BASE_URL = 'http://localhost:5173';"
  $storeBaseUrl = "const ROLLCODEX_APP_BASE_URL = 'https://rollcodex.app';"
  if (-not $roll20Content.Contains($devBaseUrl)) {
    throw "Base URL dev introuvable dans roll20-content.js. Packaging store arrete."
  }
  $roll20Content = $roll20Content.Replace($devBaseUrl, $storeBaseUrl)
  [System.IO.File]::WriteAllText($roll20ContentPath, $roll20Content, $utf8NoBom)

  $backgroundPath = Join-Path $stagingPath "background.js"
  $backgroundContent = Get-Content -Raw -Path $backgroundPath
  $localEndpointPattern = "\s+const isLocal = host === 'localhost' \|\| host === '127\.0\.0\.1';\r?\n\s+const isSupabase = host\.endsWith\('\.supabase\.co'\);\r?\n\s+return \['http:', 'https:'\]\.includes\(url\.protocol\)\r?\n\s+&& \(isLocal \|\| isSupabase\)"
  $storeEndpointGuard = "`n      const isSupabase = host.endsWith('.supabase.co');`n      return url.protocol === 'https:'`n        && isSupabase"
  $patchedBackgroundContent = $backgroundContent -replace $localEndpointPattern, $storeEndpointGuard
  if ($patchedBackgroundContent.Contains("localhost") -or $patchedBackgroundContent.Contains("127.0.0.1")) {
    throw "Endpoints locaux encore presents dans background.js apres patch store."
  }
  [System.IO.File]::WriteAllText($backgroundPath, $patchedBackgroundContent, $utf8NoBom)
}

$packageEntries = Get-ChildItem -Force -Path $stagingPath | ForEach-Object { $_.FullName }
Compress-Archive -Path $packageEntries -DestinationPath $zipPath
Copy-Item -Recurse -Path $stagingPath -Destination $unpackedPath
Remove-Item -Recurse -Force $stagingPath

Write-Host "Package Chrome $channelName pret: $zipPath"
Write-Host "Extension non empaquetee $channelName prete: $unpackedPath"
if ($channelName -eq "store") {
  Write-Host "Canal store: rollcodex.app, app.roll20.net et Supabase uniquement."
} else {
  Write-Host "Canal dev: localhost, localtest.me, app.roll20.net et Supabase."
}
