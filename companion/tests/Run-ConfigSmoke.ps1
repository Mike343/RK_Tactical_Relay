[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$vcvars = & "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe" -latest -products * -find "VC\Auxiliary\Build\vcvars64.bat"
if (-not $vcvars) { throw "Visual Studio with the C++ workload was not found" }

$out = Join-Path $env:TEMP "rk-configsmoke"
New-Item -ItemType Directory -Force $out | Out-Null
$src = Join-Path $PSScriptRoot "..\src"
$bat = Join-Path $out "build.bat"
"@echo off`r`ncall `"$vcvars`" >nul`r`ncd /d `"$out`"`r`ncl /nologo /EHsc /std:c++17 /W4 /I `"$src`" `"$PSScriptRoot\ConfigSmoke.cpp`" `"$src\Config.cpp`" /Fe:ConfigSmoke.exe /link ole32.lib" | Set-Content $bat -Encoding ascii
Remove-Item (Join-Path $out "*.exe") -Force -ErrorAction SilentlyContinue
& cmd.exe /d /c "`"$bat`"" | Out-Null
if (-not (Test-Path (Join-Path $out "ConfigSmoke.exe"))) { throw "The test failed to compile" }

& (Join-Path $out "ConfigSmoke.exe")
exit $LASTEXITCODE
