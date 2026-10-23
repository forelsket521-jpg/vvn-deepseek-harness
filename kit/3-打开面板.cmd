@echo off
chcp 65001 >nul
title dsh-scrub panel
cd /d "%~dp0"
call "%~dp0_node.cmd"
if errorlevel 1 exit /b 1

set "DSH_SURFACE=desktop"
set "DSH_HOME=%USERPROFILE%\.dsh"
set "PORT=43190"

echo.
echo Panel: http://127.0.0.1:%PORT%/scrub/
echo Close this window to stop the panel.
echo.

start "" "http://127.0.0.1:%PORT%/scrub/"
"%NODE_EXE%" "%~dp0dsh-scrub\bin\scrub.js" serve --port %PORT%
echo.
echo Panel stopped. If the port is busy, edit this file and change PORT.
pause