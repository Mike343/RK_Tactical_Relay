param([Parameter(Mandatory=$true)][string]$BuildDirectory)
$ErrorActionPreference = 'Stop'
$build = (Resolve-Path -LiteralPath $BuildDirectory).Path
$files = @('RKTacticalCompanion.exe', 'companion.ini', 'Audio') | ForEach-Object { Join-Path $build $_ }
foreach ($file in $files) { if (-not (Test-Path -LiteralPath $file)) { throw "Missing Companion output: $file" } }
foreach ($sound in @('Explosion.wav','brrrt.wav')) {
    if (-not (Test-Path -LiteralPath (Join-Path $build "Audio/$sound"))) { throw "Missing battlefield sound: $sound" }
}
$dll = Join-Path $build 'SimConnect.dll'
if (Test-Path -LiteralPath $dll) { $files += $dll }
$destination = Join-Path $PSScriptRoot 'dist/Tactical Companion.zip'
New-Item -ItemType Directory -Force (Split-Path $destination) | Out-Null
Compress-Archive -LiteralPath $files -DestinationPath $destination -Force
Write-Host "Updated packaged Companion: $destination"
