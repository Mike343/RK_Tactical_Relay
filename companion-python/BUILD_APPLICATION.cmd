@echo off
setlocal
cd /d "%~dp0"
set "RK_PYTHON="
set "RK_PYTHON_ARG="
rem Try installed launchers and standard install folders without relying on PATH.
for %%V in (3.14 3.13 3.12 3.11 3.10) do (
  call :probe "%LocalAppData%\Programs\Python\Launcher\py.exe" -%%V
  call :probe "%SystemRoot%\py.exe" -%%V
  call :probe py -%%V
)
for %%V in (314 313 312 311 310) do (
  call :probe "%LocalAppData%\Programs\Python\Python%%V\python.exe"
  call :probe "%ProgramFiles%\Python%%V\python.exe"
  call :probe "%SystemDrive%\Python%%V\python.exe"
)
call :probe python
if not defined RK_PYTHON goto missing
 echo Using "%RK_PYTHON%" %RK_PYTHON_ARG%
"%RK_PYTHON%" %RK_PYTHON_ARG% build_windows.py
set "RK_BUILD_RESULT=%ERRORLEVEL%"
if not "%RK_BUILD_RESULT%"=="0" echo Build failed. Read the error above before closing this window.
pause
exit /b %RK_BUILD_RESULT%

:missing
echo The builder could not find a supported 64-bit Python installation.
echo This does not mean the companion itself failed.
echo.
echo 1. Install Python 3.12.10 using the Windows 64-bit installer:
echo https://www.python.org/ftp/python/3.12.10/python-3.12.10-amd64.exe
echo 2. Select Add python.exe to PATH, then Install Now.
echo 3. Close this window and double-click BUILD_APPLICATION.cmd again.
echo.
echo Python is needed on the build PC only. Users receive the finished ZIP.
pause
exit /b 1

:probe
if defined RK_PYTHON exit /b 0
"%~1" %~2 -c "import sys,struct;sys.exit(0 if (3,10) <= sys.version_info[:2] <= (3,14) and struct.calcsize('P')==8 else 1)" >nul 2>&1
if errorlevel 1 exit /b 0
set "RK_PYTHON=%~1"
set "RK_PYTHON_ARG=%~2"
exit /b 0
