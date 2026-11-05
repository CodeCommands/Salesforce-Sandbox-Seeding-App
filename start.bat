@echo off
rem ---------------------------------------------------------------------------
rem  Sandbox Seeder launcher
rem  Starts the local web server (server.ps1) with Windows PowerShell and opens
rem  the app in your default browser. No installs or admin rights needed.
rem
rem  Usage:  start.bat            (port 5050)
rem          start.bat 5051       (custom port; register the matching callback URL)
rem ---------------------------------------------------------------------------
setlocal EnableExtensions
title Sandbox Seeder
cd /d "%~dp0"

set "PORT=5050"
if not "%~1"=="" set "PORT=%~1"

echo.
echo   Sandbox Seeder - starting local server on http://localhost:%PORT%/
echo   Keep this window open while you use the app. Press Ctrl+C to stop.
echo.

where powershell.exe >nul 2>&1
if errorlevel 1 (
    echo   ERROR: Windows PowerShell was not found on this PC.
    goto :fail
)

if not exist "%~dp0server.ps1" (
    echo   ERROR: server.ps1 is missing next to start.bat.
    goto :fail
)

rem A Group Policy execution policy overrides -ExecutionPolicy Bypass for script files.
set "GPO_POLICY=Undefined"
for /f "usebackq delims=" %%P in (`powershell.exe -NoProfile -NonInteractive -Command "$m = Get-ExecutionPolicy -Scope MachinePolicy; $u = Get-ExecutionPolicy -Scope UserPolicy; if ($m -ne 'Undefined') { $m } else { $u }"`) do set "GPO_POLICY=%%P"

if /i "%GPO_POLICY%"=="Undefined" goto :run_file
if /i "%GPO_POLICY%"=="Bypass" goto :run_file
if /i "%GPO_POLICY%"=="Unrestricted" goto :run_file

echo   Group Policy sets the PowerShell execution policy to "%GPO_POLICY%".
echo   That setting overrides -ExecutionPolicy Bypass for script files.
echo.
echo   The server can instead be loaded into memory for this session only.
echo   Check that this is allowed by your IT policy before continuing.
echo.
choice /c YN /m "  Load server.ps1 into memory now"
if errorlevel 2 goto :fail
goto :run_inline

:run_file
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0server.ps1" -Port %PORT%
goto :done

:run_inline
powershell.exe -NoProfile -Command "& ([scriptblock]::Create([System.IO.File]::ReadAllText('%~dp0server.ps1'))) -Port %PORT% -Root '%~dp0public'"
goto :done

:done
if errorlevel 1 goto :fail
endlocal
exit /b 0

:fail
echo.
echo   The server did not start or stopped with an error. See the messages above.
echo   Help: README.md, section "Troubleshooting".
pause
endlocal
exit /b 1
