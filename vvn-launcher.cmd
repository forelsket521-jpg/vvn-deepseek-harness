@echo off
rem ============================================================
rem  vvn console - ASCII only (cmd.exe reads .cmd as ANSI).
rem  Chinese text lives in menu.txt, printed with type.
rem  No args  -> open the panel directly.
rem  With arg -> jump to that action (1..8, 0).
rem ============================================================
chcp 65001 >nul
title vvn console
cd /d "%~dp0"
call "%~dp0_node.cmd"
if errorlevel 1 goto end

set "DSH_SURFACE=desktop"
set "DSH_HOME=%USERPROFILE%\.dsh"
set "PURGE=%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-purge"
set "SCRUB=%~dp0kit\dsh-scrub\bin\scrub.js"
set "PANEL_PORT=43190"

if "%~1"=="" goto panel
set "KEY=%~1"
goto dispatch

:menu
cls
if exist "%~dp0menu.txt" type "%~dp0menu.txt"
echo.
set "KEY="
set /p KEY=  ^> 
if "%KEY%"=="" goto menu
set "KEY=%KEY:~0,1%"

:dispatch
if "%KEY%"=="1" goto panel
if "%KEY%"=="2" goto allinone
if "%KEY%"=="3" goto scrub
if "%KEY%"=="4" goto inject
if "%KEY%"=="5" goto status
if "%KEY%"=="6" goto restore
if "%KEY%"=="7" goto install
if "%KEY%"=="8" goto manual
if "%KEY%"=="0" goto quit
ping -n 2 127.0.0.1 >nul
goto menu

:panel
echo.
echo   Panel: http://127.0.0.1:%PANEL_PORT%/scrub/
echo   Close this window to stop.
echo.
start "" "http://127.0.0.1:%PANEL_PORT%/scrub/"
"%NODE_EXE%" "%SCRUB%" serve --port %PANEL_PORT%
goto end

:allinone
echo.
echo   [1/3] locate dsh
"%NODE_EXE%" "%SCRUB%" status
echo.
echo   [2/3] scrub host (snapshot first)
if not exist "%PURGE%\bin\dsh-purge.js" goto nopurge
"%NODE_EXE%" "%PURGE%\bin\dsh-purge.js" --apply
echo.
echo   [3/3] inject prompt (vvn)
"%NODE_EXE%" "%SCRUB%" prompt --import
echo.
echo   Done. Restart dsh to take effect.
echo.
pause
goto end

:scrub
echo.
echo   Scrub host now? A snapshot is taken first.
echo   Press any key to continue, close the window to cancel.
pause >nul
if not exist "%PURGE%\bin\dsh-purge.js" goto nopurge
"%NODE_EXE%" "%PURGE%\bin\dsh-purge.js" --apply
echo.
pause
goto end

:nopurge
echo   dsh-purge not installed, cannot scrub.
pause
goto end

:inject
echo.
echo   Inject the vvn prompt into dsh.
"%NODE_EXE%" "%SCRUB%" prompt --import
echo.
"%NODE_EXE%" "%SCRUB%" prompt --show
echo.
echo   Restart dsh to take effect.
echo.
pause
goto end

:status
echo.
echo   ==================== host status ====================
if not exist "%PURGE%\bin\dsh-purge.js" goto nopurge2
"%NODE_EXE%" "%PURGE%\bin\dsh-purge.js" --status
goto statusverify

:nopurge2
echo   dsh-purge not installed.

:statusverify
echo.
echo   ==================== verify ====================
if not exist "%SCRUB%" goto noscurb
"%NODE_EXE%" "%SCRUB%" verify

:noscurb
echo.
echo   ==================== regression ====================
if not exist "%~dp0kit\dsh-purge-patches\purge-fix-test.mjs" goto hold
"%NODE_EXE%" "%~dp0kit\dsh-purge-patches\purge-fix-test.mjs"

:hold
echo.
echo   Press any key to return.
pause >nul
goto menu

:restore
if not exist "%~dp0dsh-restore.cmd" goto norestore
call "%~dp0dsh-restore.cmd"
goto end

:norestore
echo   Missing dsh-restore.cmd
pause
goto end

:install
if not exist "%~dp0dsh-install.cmd" goto noinstall
call "%~dp0dsh-install.cmd"
goto end

:noinstall
echo   Missing dsh-install.cmd
pause
goto end

:manual
if not exist "%~dp0manual.txt" goto nomanual
start "" notepad "%~dp0manual.txt"
goto end

:nomanual
echo   Missing manual.txt
ping -n 2 127.0.0.1 >nul
goto end

:quit
exit /b 0

:end
exit /b 0