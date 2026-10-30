[CmdletBinding()]
param([switch]$SkipCompanionBuild)

$ErrorActionPreference = "Stop"
$repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$seven = "C:\Program Files\7-Zip\7z.exe"
if (-not (Test-Path $seven)) { throw "7-Zip is needed to zip the panel (it is over 2 GB limits for Compress-Archive on older PowerShell)." }

if (-not $SkipCompanionBuild) { & (Join-Path $repo "companion\Release-Companion.ps1") }
& (Join-Path $PSScriptRoot "Update-BundledCompanion.ps1")
$global:LASTEXITCODE = 0
& (Join-Path $PSScriptRoot "Check-PanelCompatibility.ps1")
if ($LASTEXITCODE -ne 0) { throw "The compatibility check failed" }

$panelRoot = Join-Path $repo "panel\rk-tactical-panel-24"
$version = (Get-Content (Join-Path $panelRoot "manifest.json") -Raw | ConvertFrom-Json).package_version
$companionVersion = [regex]::Match((Get-Content (Join-Path $repo "companion\src\Version.h") -Raw), 'RK_COMPANION_VERSION L"([^"]+)"').Groups[1].Value

$out = Join-Path $repo "dist\addon"
Remove-Item $out -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $out | Out-Null

$panelZip = Join-Path $out "rk-tactical-panel-24-$version.zip"
Push-Location (Split-Path $panelRoot -Parent)
& $seven a -tzip -mx=3 $panelZip "rk-tactical-panel-24" | Out-Null
Pop-Location
if (-not (Test-Path $panelZip)) { throw "Zipping the panel failed" }

Copy-Item (Join-Path $repo "companion\dist\RKTacticalCompanion-$companionVersion.zip") $out
Copy-Item (Join-Path $repo "companion\dist\RKTacticalCompanion-$companionVersion.zip.sha256") $out

Get-ChildItem $out | ForEach-Object { Write-Host ("{0,10:N0} MB  {1}" -f ($_.Length / 1MB), $_.Name) }
Write-Host "`nUpload these to the addon. The panel zip holds the package folder to copy into the MSFS Community folder."
