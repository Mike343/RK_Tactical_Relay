[CmdletBinding()]
param([switch]$SkipBuild)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$source = Get-Content "app\companion.py" -Raw
if ($source -notmatch '(?m)^VERSION = "([^"]+)"') { throw "No VERSION found in app\companion.py" }
$version = $Matches[1]

if (-not $SkipBuild) {
    $global:LASTEXITCODE = 0
    & python build_windows.py
    if ($LASTEXITCODE -ne 0) { throw "The build failed" }
}

$release = Join-Path $PSScriptRoot "RELEASE"
$exe = Join-Path $release "RKTacticalCompanion.exe"
if (-not (Test-Path $exe)) { throw "Missing build output: $exe" }
$reported = (& $exe --version).Trim()
if ($reported -ne $version) { throw "The exe reports version $reported, the source says $version" }

$dist = Join-Path $PSScriptRoot "dist"
New-Item -ItemType Directory -Force $dist | Out-Null
$zip = Join-Path $dist "RKTacticalCompanion-$version.zip"
Copy-Item (Join-Path $release "RK_Tactical_Companion_Windows.zip") $zip -Force
$hash = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
"$hash  $(Split-Path $zip -Leaf)" | Set-Content "$zip.sha256" -Encoding ascii

Write-Host "Built $zip"
Write-Host "SHA256 $hash"
