[CmdletBinding()]
param(
    [string]$Exe,
    [string[]]$Panel
)

$ErrorActionPreference = "Stop"
if (-not $Panel) {
    $Panel = @((Join-Path $PSScriptRoot "..\panel\rk-tactical-panel-24"), (Join-Path $PSScriptRoot "..\panel\rk-tactical-panel-20"))
}
if (-not $Exe) { $Exe = Join-Path $PSScriptRoot "..\companion-python\RELEASE\RKTacticalCompanion.exe" }
if (-not (Test-Path $Exe)) { throw "No Companion exe found. Run companion-python\Release-Companion.ps1 first." }
$Exe = (Resolve-Path $Exe).Path

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
foreach ($p in $Panel) {
    $p = (Resolve-Path $p).Path
    $copy = Join-Path $p "copy"
    New-Item -ItemType Directory -Force $copy | Out-Null
    Remove-Item (Join-Path $copy "Tactical Companion.zip") -Force -ErrorAction SilentlyContinue
    $destination = Join-Path $copy "RKTacticalCompanion.zip"
    Remove-Item $destination -Force -ErrorAction SilentlyContinue
    $archive = [IO.Compression.ZipFile]::Open($destination, [IO.Compression.ZipArchiveMode]::Create)
    try {
        [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $Exe, "RKTacticalCompanion.exe", [IO.Compression.CompressionLevel]::Optimal)
    }
    finally {
        $archive.Dispose()
    }
    & (Join-Path $PSScriptRoot "Update-PanelLayout.ps1") -Panel $p
    Write-Host "Bundled the Companion into $destination"
}
