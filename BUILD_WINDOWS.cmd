@echo off
setlocal
cd /d "%~dp0"
if errorlevel 1 (
  echo ERROR: Cannot open the Go source directory.
  pause
  exit /b 1
)

rem Check Go by actually running it. The 'where' utility may be missing.
set "GO_EXE=go"
go version >nul 2>&1
if errorlevel 1 (
  set "GO_EXE=%ProgramFiles%\Go\bin\go.exe"
  if not exist "%ProgramFiles%\Go\bin\go.exe" (
    echo ERROR: Go not available from PATH or the standard installation directory.
    echo Open a Command Prompt and run: go version
    pause
    exit /b 1
  )
)

"%GO_EXE%" version
if errorlevel 1 (
  echo ERROR: Could not launch Go.
  pause
  exit /b 1
)
set "GOOS=windows"
set "GOARCH=amd64"
set "CGO_ENABLED=0"
"%GO_EXE%" build -trimpath -o RKTacticalRelay.exe .
if errorlevel 1 (
  echo BUILD FAILED. Compiler output is shown above.
  pause
  exit /b 1
)
echo SUCCESS: RKTacticalRelay.exe
pause
endlocal
