[CmdletBinding()]
param(
    [string]$CompanionZip,
    [string]$Panel
)

$ErrorActionPreference = "Stop"
if (-not $Panel) { $Panel = Join-Path $PSScriptRoot "..\panel\rk-tactical-panel-24" }
$Panel = (Resolve-Path $Panel).Path
if (-not $CompanionZip) {
    $CompanionZip = Get-ChildItem (Join-Path $PSScriptRoot "..\companion\dist") -Filter "RKTacticalCompanion-*.zip" |
        Sort-Object { [version]($_.BaseName -replace '^RKTacticalCompanion-', '') } -Descending |
        Select-Object -First 1 -ExpandProperty FullName
}
if (-not $CompanionZip -or -not (Test-Path $CompanionZip)) { throw "No Companion zip found. Run companion\Release-Companion.ps1 first." }

$work = Join-Path $env:TEMP "rk-bundle-companion"
Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
Expand-Archive $CompanionZip $work
$inner = Get-ChildItem $work -Directory | Select-Object -First 1
Rename-Item $inner.FullName "Tactical Companion"

$destination = Join-Path $Panel "copy\Tactical Companion.zip"
Remove-Item $destination -Force -ErrorAction SilentlyContinue

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::Open($destination, [IO.Compression.ZipArchiveMode]::Create)
try {
    foreach ($file in Get-ChildItem (Join-Path $work "Tactical Companion") -Recurse -File) {
        $entry = $file.FullName.Substring($work.Length + 1).Replace("\", "/")
        [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $file.FullName, $entry, [IO.Compression.CompressionLevel]::Optimal)
    }
}
finally {
    $archive.Dispose()
}
Remove-Item $work -Recurse -Force

& (Join-Path $PSScriptRoot "Update-PanelLayout.ps1") -Panel $Panel
Write-Host "Bundled $(Split-Path $CompanionZip -Leaf) into $destination"
