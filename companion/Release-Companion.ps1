[CmdletBinding()]
param([switch]$SkipBuild)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$header = Get-Content "src\Version.h" -Raw
if ($header -notmatch 'RK_COMPANION_VERSION L"([^"]+)"') { throw "No version found in src\Version.h" }
$version = $Matches[1]

if (-not $SkipBuild) {
    & cmd.exe /d /c "`"$PSScriptRoot\BUILD_RELEASE.bat`""
    if ($LASTEXITCODE -ne 0) { throw "The build failed" }
}

$out = Join-Path $PSScriptRoot "bin\Release"
foreach ($name in "RKTacticalCompanion.exe", "companion.ini", "SimConnect.dll", "Audio") {
    if (-not (Test-Path (Join-Path $out $name))) { throw "Missing build output: $name" }
}
if ((Get-Content (Join-Path $out "companion.ini") -Raw) -notmatch '(?m)^relay_url=\S+') {
    throw "relay_url is empty in companion.ini"
}

$dist = Join-Path $PSScriptRoot "dist"
$stage = Join-Path $dist "stage"
$folder = Join-Path $stage "RK Tactical Companion"
Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $folder | Out-Null
foreach ($name in "RKTacticalCompanion.exe", "companion.ini", "SimConnect.dll", "Audio") {
    Copy-Item (Join-Path $out $name) $folder -Recurse
}
Copy-Item "PLAYER_README.txt" (Join-Path $folder "README.txt")
Copy-Item "SimConnect.xml.example" $folder

$zip = Join-Path $dist "RKTacticalCompanion-$version.zip"
Remove-Item $zip -Force -ErrorAction SilentlyContinue
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::Open($zip, [IO.Compression.ZipArchiveMode]::Create)
try {
    foreach ($file in Get-ChildItem $folder -Recurse -File) {
        $entry = $file.FullName.Substring($stage.Length + 1).Replace("\", "/")
        [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $file.FullName, $entry, [IO.Compression.CompressionLevel]::Optimal)
    }
}
finally {
    $archive.Dispose()
}
Remove-Item $stage -Recurse -Force

$hash = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
"$hash  $(Split-Path $zip -Leaf)" | Set-Content "$zip.sha256" -Encoding ascii

Write-Host "Built $zip"
Write-Host "SHA256 $hash"
Write-Host ""
Write-Host "Publish it with:"
Write-Host "  gh release create companion-v$version `"$zip`" `"$zip.sha256`" --title `"RK Tactical Companion $version`" --notes-file RELEASE_NOTES.md"
