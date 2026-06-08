param(
  [ValidateSet("store", "dev", "firefox-store", "firefox-dev", "safari-store", "safari-dev")]
  [string]$Channel = "store",
  [string]$OutputDirectory = "dist"
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$manifestPath = Join-Path $root "manifest.json"
$manifest = Get-Content -Raw -Encoding UTF8 -Path $manifestPath | ConvertFrom-Json
$version = $manifest.version
$channelName = $Channel.ToLowerInvariant()
if ($channelName -eq "store" -or $channelName -eq "dev") {
  $browserName = "chromium"
  $releaseName = $channelName
} else {
  $channelParts = $channelName.Split("-", 2)
  $browserName = $channelParts[0]
  $releaseName = $channelParts[1]
}

$zipSuffix = if ($browserName -eq "chromium") { $releaseName } else { $channelName }
$zipName = "rollcodex-roll20-v$version-$zipSuffix.zip"
$outputPath = Join-Path $root $OutputDirectory
$zipPath = Join-Path $outputPath $zipName
$stagingPath = Join-Path $outputPath "package-$channelName"
$unpackedPath = Join-Path $outputPath "unpacked-$channelName"
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

New-Item -ItemType Directory -Force -Path $outputPath | Out-Null
if (Test-Path $zipPath) { Remove-Item -Force $zipPath }
if (Test-Path $stagingPath) { Remove-Item -Recurse -Force $stagingPath }
if (Test-Path $unpackedPath) { Remove-Item -Recurse -Force $unpackedPath }
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

function Set-ManifestProperty($target, $name, $value) {
  $target | Add-Member -NotePropertyName $name -NotePropertyValue $value -Force
}

function Remove-ManifestProperty($target, $name) {
  if ($target.PSObject.Properties[$name]) {
    $target.PSObject.Properties.Remove($name)
  }
}

function Set-BrowserManifest($target, $browser) {
  if ($browser -eq "firefox") {
    Set-ManifestProperty $target "background" ([pscustomobject]@{
      scripts = @("background.js")
    })
    Set-ManifestProperty $target "browser_specific_settings" ([pscustomobject]@{
      gecko = [pscustomobject]@{
        id = "rollcodex-roll20@rollcodex.app"
        strict_min_version = "121.0"
      }
    })
    return
  }

  if ($browser -eq "safari") {
    Set-ManifestProperty $target "background" ([pscustomobject]@{
      scripts = @("background.js")
      service_worker = "background.js"
      preferred_environment = @("service_worker", "document")
    })
    Remove-ManifestProperty $target "browser_specific_settings"
    return
  }

  Set-ManifestProperty $target "background" ([pscustomobject]@{
    service_worker = "background.js"
  })
  Remove-ManifestProperty $target "browser_specific_settings"
}

$stagedManifestPath = Join-Path $stagingPath "manifest.json"
$stagedManifest = Get-Content -Raw -Encoding UTF8 -Path $stagedManifestPath | ConvertFrom-Json

if ($releaseName -eq "store") {
  $stagedManifest.host_permissions = @(
    "https://rollcodex.app/*",
    "https://*.supabase.co/*",
    "https://app.roll20.net/*"
  )

  foreach ($contentScript in $stagedManifest.content_scripts) {
    if (@($contentScript.js) -contains "rollcodex-content.js") {
      $contentScript.matches = @("https://rollcodex.app/*")
    }
  }

  $roll20ContentPath = Join-Path $stagingPath "roll20-content.js"
  $roll20Content = Get-Content -Raw -Encoding UTF8 -Path $roll20ContentPath
  $devBaseUrl = "const ROLLCODEX_APP_BASE_URL = 'http://localhost:5173';"
  $storeBaseUrl = "const ROLLCODEX_APP_BASE_URL = 'https://rollcodex.app';"
  if (-not $roll20Content.Contains($devBaseUrl)) {
    throw "Base URL dev introuvable dans roll20-content.js. Packaging store arrete."
  }
  $roll20Content = $roll20Content.Replace($devBaseUrl, $storeBaseUrl)
  [System.IO.File]::WriteAllText($roll20ContentPath, $roll20Content, $utf8NoBom)

  $backgroundPath = Join-Path $stagingPath "background.js"
  $backgroundContent = Get-Content -Raw -Encoding UTF8 -Path $backgroundPath
  $localEndpointPattern = "\s+const isLocal = host === 'localhost' \|\| host === '127\.0\.0\.1';\r?\n\s+const isSupabase = host\.endsWith\('\.supabase\.co'\);\r?\n\s+return \['http:', 'https:'\]\.includes\(url\.protocol\)\r?\n\s+&& \(isLocal \|\| isSupabase\)"
  $storeEndpointGuard = "`n      const isSupabase = host.endsWith('.supabase.co');`n      return url.protocol === 'https:'`n        && isSupabase"
  $patchedBackgroundContent = $backgroundContent -replace $localEndpointPattern, $storeEndpointGuard
  $localConnectUrlPattern = "\s+const isLocal = host === 'localhost' \|\| host === '127\.0\.0\.1' \|\| host === 'localtest\.me';\r?\n\s+const isRollCodex = host === 'rollcodex\.app' \|\| host === 'rollledger\.vercel\.app';\r?\n\s+return \['http:', 'https:'\]\.includes\(url\.protocol\)\r?\n\s+&& \(isLocal \|\| isRollCodex\)"
  $storeConnectUrlGuard = "`n      const isRollCodex = host === 'rollcodex.app';`n      return url.protocol === 'https:'`n        && isRollCodex"
  $patchedBackgroundContent = $patchedBackgroundContent -replace $localConnectUrlPattern, $storeConnectUrlGuard
  if ($patchedBackgroundContent.Contains("localhost") -or $patchedBackgroundContent.Contains("127.0.0.1") -or $patchedBackgroundContent.Contains("localtest.me")) {
    throw "Endpoints locaux encore presents dans background.js apres patch store."
  }
  [System.IO.File]::WriteAllText($backgroundPath, $patchedBackgroundContent, $utf8NoBom)
}

Set-BrowserManifest $stagedManifest $browserName
[System.IO.File]::WriteAllText($stagedManifestPath, ($stagedManifest | ConvertTo-Json -Depth 20), $utf8NoBom)

$packageEntries = Get-ChildItem -Force -Path $stagingPath | ForEach-Object { $_.FullName }
Compress-Archive -Path $packageEntries -DestinationPath $zipPath
Copy-Item -Recurse -Path $stagingPath -Destination $unpackedPath
Remove-Item -Recurse -Force $stagingPath

Write-Host "Package $browserName $releaseName pret: $zipPath"
Write-Host "Extension non empaquetee $channelName prete: $unpackedPath"
if ($releaseName -eq "store") {
  Write-Host "Canal store: rollcodex.app, app.roll20.net et Supabase uniquement."
} else {
  Write-Host "Canal dev: localhost, localtest.me, app.roll20.net et Supabase."
}
