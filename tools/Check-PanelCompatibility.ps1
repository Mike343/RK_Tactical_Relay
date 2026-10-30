[CmdletBinding()]
param(
    [string]$Panel,
    [string]$Companion
)

$ErrorActionPreference = "Stop"
if (-not $Panel) { $Panel = Join-Path $PSScriptRoot "..\panel\rk-tactical-panel-24" }
if (-not $Companion) { $Companion = Join-Path $PSScriptRoot "..\companion" }
$Panel = (Resolve-Path $Panel).Path
$Companion = (Resolve-Path $Companion).Path
$script:failures = 0

function Check($ok, $text) {
    if ($ok) { Write-Host "ok: $text" -ForegroundColor Green }
    else { Write-Host "FAIL: $text" -ForegroundColor Red; $script:failures++ }
}

$expected = @(Select-String -Path (Join-Path $Companion "src\Protocol.h") -Pattern 'AreaName\[\] = "([^"]+)"' | ForEach-Object { $_.Matches[0].Groups[1].Value })
$wasm = [Text.Encoding]::ASCII.GetString([IO.File]::ReadAllBytes((Join-Path $Panel "modules\RKTacticalSpawner.wasm")))

foreach ($name in $expected) { Check $wasm.Contains($name) "the panel WASM uses the Companion's data area $name" }
foreach ($name in ([regex]::Matches($wasm, 'RK_TACTICAL_[A-Z0-9_]+') | ForEach-Object Value | Sort-Object -Unique)) {
    Check ($expected -contains $name) "the Companion provides $name"
}

$layout = (Get-Content (Join-Path $Panel "layout.json") -Raw | ConvertFrom-Json).content
$bad = 0
foreach ($entry in $layout) {
    $path = Join-Path $Panel $entry.path.Replace("/", "\")
    if (-not (Test-Path $path)) { $bad++; continue }
    if ((Get-Item $path).Length -ne $entry.size) { $bad++ }
}
Check ($bad -eq 0) "layout.json matches the files on disk ($bad differ, run tools\Update-PanelLayout.ps1 if not)"
$manifestTotal = [long](Get-Content (Join-Path $Panel "manifest.json") -Raw | ConvertFrom-Json).total_package_size
Check ($manifestTotal -eq ($layout | Measure-Object size -Sum).Sum) "manifest total_package_size matches layout.json"

$version = [regex]::Match((Get-Content (Join-Path $Companion "src\Version.h") -Raw), 'RK_COMPANION_VERSION L"([^"]+)"').Groups[1].Value
$bundle = Join-Path $Panel "copy\Tactical Companion.zip"
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::OpenRead($bundle)
try {
    $exe = $archive.Entries | Where-Object { $_.Name -eq "RKTacticalCompanion.exe" } | Select-Object -First 1
    $stream = $exe.Open(); $memory = New-Object IO.MemoryStream; $stream.CopyTo($memory); $stream.Close()
    $exeText = [Text.Encoding]::Unicode.GetString($memory.ToArray())
    Check $exeText.Contains("RKTacticalCompanion/$version") "the bundled Companion is version $version"
    $ini = $archive.Entries | Where-Object { $_.Name -eq "companion.ini" } | Select-Object -First 1
    $reader = New-Object IO.StreamReader($ini.Open()); $bundledIni = $reader.ReadToEnd(); $reader.Close()
} finally { $archive.Dispose() }
$ours = [regex]::Match((Get-Content (Join-Path $Companion "companion.ini") -Raw), '(?m)^relay_url=(\S+)').Groups[1].Value
$theirs = [regex]::Match($bundledIni, '(?m)^relay_url=(\S+)').Groups[1].Value
Check ($ours -eq $theirs) "the bundled Companion points at $ours (it has $theirs)"

if ($script:failures) { Write-Host "`n$script:failures problem(s)." -ForegroundColor Red; exit 1 }
Write-Host "`nThe panel, the bundled Companion and the Companion source agree."
exit 0
