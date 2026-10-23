@echo off
chcp 65001 >nul
title dsh purge status
cd /d "%~dp0"
call "%~dp0_node.cmd"
if errorlevel 1 exit /b 1

set "DSH_SURFACE=desktop"
set "DSH_HOME=%USERPROFILE%\.dsh"
set "PURGE=%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-purge"

echo.
echo ==================== dsh-purge status ====================
if not exist "%PURGE%\bin\dsh-purge.js" goto nopurge
"%NODE_EXE%" "%PURGE%\bin\dsh-purge.js" --status
goto afterpurge

:nopurge
echo   dsh-purge is not installed - skipped.

:afterpurge
echo.
echo ==================== dsh-scrub verify ====================
if not exist "%~dp0dsh-scrub\bin\scrub.js" goto noscrub
"%NODE_EXE%" "%~dp0dsh-scrub\bin\scrub.js" verify
goto afterverify

:noscrub
echo   Incomplete kit: dsh-scrub\bin\scrub.js missing.

:afterverify
echo.
echo ==================== regression tests ====================
if not exist "%~dp0dsh-purge-patches\purge-fix-test.mjs" goto notest
"%NODE_EXE%" "%~dp0dsh-purge-patches\purge-fix-test.mjs"
goto end

:notest
echo   Incomplete kit: dsh-purge-patches\purge-fix-test.mjs missing.

:end
echo.
pause