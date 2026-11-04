[CmdletBinding()]
param([switch]$SkipCompanionBuild)

$ErrorActionPreference = "Stop"
$repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$seven = "C:\Program Files\7-Zip\7z.exe"
if (-not (Test-Path $seven)) { throw "7-Zip is needed to zip the panel (it is over 2 GB limits for Compress-Archive on older PowerShell)." }

if (-not $SkipCompanionBuild) { & (Join-Path $repo "companion-python\Release-Companion.ps1") }
& (Join-Path $PSScriptRoot "Update-BundledCompanion.ps1")
$panels = @("rk-tactical-panel-24", "rk-tactical-panel-20")
foreach ($name in $panels) {
    $global:LASTEXITCODE = 0
    & (Join-Path $PSScriptRoot "Check-PanelCompatibility.ps1") -Panel (Join-Path $repo "panel\$name")
    if ($LASTEXITCODE -ne 0) { throw "The compatibility check failed for $name" }
}

$companionVersion = [regex]::Match((Get-Content (Join-Path $repo "companion-python\app\companion.py") -Raw), '(?m)^VERSION = "([^"]+)"').Groups[1].Value

$out = Join-Path $repo "dist\addon"
Remove-Item $out -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $out | Out-Null

foreach ($name in $panels) {
    $panelRoot = Join-Path $repo "panel\$name"
    $version = (Get-Content (Join-Path $panelRoot "manifest.json") -Raw | ConvertFrom-Json).package_version
    $panelZip = Join-Path $out "$name-$version.zip"
    Push-Location (Split-Path $panelRoot -Parent)
    & $seven a -tzip -mx=3 $panelZip $name | Out-Null
    Pop-Location
    if (-not (Test-Path $panelZip)) { throw "Zipping $name failed" }
}

Copy-Item (Join-Path $repo "companion-python\dist\RKTacticalCompanion-$companionVersion.zip") $out
Copy-Item (Join-Path $repo "companion-python\dist\RKTacticalCompanion-$companionVersion.zip.sha256") $out

Get-ChildItem $out | ForEach-Object { Write-Host ("{0,10:N0} MB  {1}" -f ($_.Length / 1MB), $_.Name) }
Write-Host "`nUpload these to the addon. The panel zip holds the package folder to copy into the MSFS Community folder."
