[CmdletBinding()]
param([string]$Panel)

$ErrorActionPreference = "Stop"
if (-not $Panel) { $Panel = Join-Path $PSScriptRoot "..\panel\rk-tactical-panel-24" }
$Panel = (Resolve-Path $Panel).Path
$layoutPath = Join-Path $Panel "layout.json"
$manifestPath = Join-Path $Panel "manifest.json"

$known = @{}
foreach ($entry in (Get-Content $layoutPath -Raw | ConvertFrom-Json).content) {
    $known[$entry.path] = $entry
}

$content = New-Object System.Collections.Generic.List[object]
$total = 0L
foreach ($file in Get-ChildItem $Panel -Recurse -File | Sort-Object FullName) {
    $relative = $file.FullName.Substring($Panel.Length + 1).Replace("\", "/").ToLower()
    if ($relative -eq "layout.json" -or $relative -eq "manifest.json") { continue }
    $old = $known[$relative]
    if ($old -and $old.size -eq $file.Length) { $date = [long]$old.date } else { $date = $file.LastWriteTimeUtc.ToFileTimeUtc() }
    $content.Add([ordered]@{ path = $relative; size = $file.Length; date = $date })
    $total += $file.Length
}

$json = [ordered]@{ content = $content } | ConvertTo-Json -Depth 4
[IO.File]::WriteAllText($layoutPath, $json, (New-Object Text.UTF8Encoding($false)))

$manifest = Get-Content $manifestPath -Raw
$updated = [regex]::Replace($manifest, '"total_package_size"\s*:\s*"\d+"', "`"total_package_size`": `"$total`"")
[IO.File]::WriteAllText($manifestPath, $updated, (New-Object Text.UTF8Encoding($false)))

Write-Host "layout.json lists $($content.Count) files, $total bytes"
