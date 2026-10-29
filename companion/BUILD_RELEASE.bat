@echo off
setlocal
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%VSWHERE%" (
  echo Visual Studio Installer vswhere.exe was not found.
  exit /b 1
)
set "RK_MSBUILD="
for /f "usebackq tokens=*" %%I in (`"%VSWHERE%" -latest -products * -requires Microsoft.Component.MSBuild -find MSBuild\**\Bin\MSBuild.exe`) do set "RK_MSBUILD=%%I"
if not defined RK_MSBUILD (
  echo MSBuild was not found. Install Visual Studio 2022 Desktop development with C++.
  exit /b 1
)
"%RK_MSBUILD%" "%~dp0RKTacticalCompanion.sln" /m /t:Build /p:Configuration=Release /p:Platform=x64
if errorlevel 1 exit /b %errorlevel%
echo.
echo Build complete: %~dp0bin\Release\RKTacticalCompanion.exe
endlocal
