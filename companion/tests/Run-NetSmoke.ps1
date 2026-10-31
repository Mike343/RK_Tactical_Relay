[CmdletBinding()]
param(
    [string]$RelayUrl = "ws://127.0.0.1:18787",
    [switch]$Reconnect
)

$ErrorActionPreference = "Stop"
$vcvars = & "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe" -latest -products * -find "VC\Auxiliary\Build\vcvars64.bat"
if (-not $vcvars) { throw "Visual Studio with the C++ workload was not found" }

$out = Join-Path $env:TEMP "rk-netsmoke"
New-Item -ItemType Directory -Force $out | Out-Null
$src = Join-Path $PSScriptRoot "..\src"
$bat = Join-Path $out "build.bat"
"@echo off`r`ncall `"$vcvars`" >nul`r`ncd /d `"$out`"`r`ncl /nologo /EHsc /std:c++17 /W4 /I `"$src`" `"$PSScriptRoot\NetSmoke.cpp`" `"$src\MultiplayerClient.cpp`" `"$src\Log.cpp`" /Fe:NetSmoke.exe /link winhttp.lib ole32.lib" | Set-Content $bat -Encoding ascii
Remove-Item (Join-Path $out "*.exe") -Force -ErrorAction SilentlyContinue
& cmd.exe /d /c "`"$bat`"" | Out-Null
if (-not (Test-Path (Join-Path $out "NetSmoke.exe"))) { throw "The test failed to compile" }

$arguments = @($RelayUrl)
if ($Reconnect) { $arguments += "reconnect" }
& (Join-Path $out "NetSmoke.exe") @arguments
exit $LASTEXITCODE
