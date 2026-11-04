[CmdletBinding()]
param(
    [string]$Panel,
    [string]$Companion
)

$ErrorActionPreference = "Stop"
if (-not $Panel) { $Panel = Join-Path $PSScriptRoot "..\panel\rk-tactical-panel-24" }
if (-not $Companion) { $Companion = Join-Path $PSScriptRoot "..\companion-python" }
$Panel = (Resolve-Path $Panel).Path
$Companion = (Resolve-Path $Companion).Path
$script:failures = 0

function Check($ok, $text) {
    if ($ok) { Write-Host "ok: $text" -ForegroundColor Green }
    else { Write-Host "FAIL: $text" -ForegroundColor Red; $script:failures++ }
}

$expected = @(Select-String -Path (Join-Path $Companion "app\sim.py") -Pattern 'b"(RK_TACTICAL_[A-Z0-9_]+)"' | ForEach-Object { $_.Matches[0].Groups[1].Value })
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
$manifestTotal = (Get-Content (Join-Path $Panel "manifest.json") -Raw | ConvertFrom-Json).total_package_size
if ($manifestTotal) {
    Check ([long]$manifestTotal -eq ($layout | Measure-Object size -Sum).Sum) "manifest total_package_size matches layout.json"
}

$version = [regex]::Match((Get-Content (Join-Path $Companion "app\companion.py") -Raw), '(?m)^VERSION = "([^"]+)"').Groups[1].Value
$bundle = Join-Path $Panel "copy\RKTacticalCompanion.zip"
if (-not (Test-Path $bundle)) {
    if ($script:failures) { Write-Host "`n$script:failures problem(s)." -ForegroundColor Red; exit 1 }
    Write-Host "`nThe panel and the Companion source agree (this package has no bundled Companion)."
    exit 0
}
Add-Type -AssemblyName System.IO.Compression.FileSystem
$work = Join-Path $env:TEMP "rk-check-companion"
Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory $work | Out-Null
[IO.Compression.ZipFile]::ExtractToDirectory($bundle, $work)
$exe = Join-Path $work "RKTacticalCompanion.exe"
Check (Test-Path $exe) "the bundle holds RKTacticalCompanion.exe"
if (Test-Path $exe) {
    $reported = (& $exe --version | Out-String).Trim()
    Check ($reported -eq $version) "the bundled Companion is version $version (it reports $reported)"
    $built = Join-Path $Companion "RELEASE\RKTacticalCompanion.exe"
    if (Test-Path $built) {
        Check ((Get-FileHash $exe).Hash -eq (Get-FileHash $built).Hash) "the bundled Companion is the exe built from the source"
    }
}
Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
$ini = Join-Path $Companion "app\companion.ini"
Check ((Get-Content $ini -Raw) -match '(?m)^relay_url=ws') "the Companion default relay_url is set"

if ($script:failures) { Write-Host "`n$script:failures problem(s)." -ForegroundColor Red; exit 1 }
Write-Host "`nThe panel, the bundled Companion and the Companion source agree."
exit 0
