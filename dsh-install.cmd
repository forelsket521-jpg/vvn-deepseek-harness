@echo off
rem Install dsh-scrub into the dsh profile (dry run first, then confirm).
chcp 65001 >nul
title dsh-scrub install
cd /d "%~dp0"
call "%~dp0_node.cmd"
if errorlevel 1 exit /b 1

set "KIT=%~dp0kit"
if not exist "%KIT%\dsh-scrub\tools\install.mjs" goto missing

echo.
echo ============================================================
echo  Install dsh-scrub into the dsh profile
echo  (panel + scrub tools + model configuration)
echo ============================================================
echo.
echo [1/3] Dry run (nothing is written)...
"%NODE_EXE%" "%KIT%\dsh-scrub\tools\install.mjs" --profile desktop
echo.
echo If the dry run reported no error, press any key to install.
echo Closing this window cancels.
pause >nul
echo.
echo [2/3] Writing into the profile...
"%NODE_EXE%" "%KIT%\dsh-scrub\tools\install.mjs" --profile desktop --apply
echo.
echo [3/3] Self check...
"%NODE_EXE%" "%KIT%\dsh-scrub\tools\plugin-smoke.mjs"
echo.
echo ============================================================
echo  Done. After restarting dsh:
echo    panel   http://127.0.0.1:19387/scrub/
echo    tools   scrub_status / scrub_apply / scrub_revert / scrub_prompt
echo    say     vvn
echo ============================================================
echo.
pause
exit /b 0

:missing
echo [ERROR] Incomplete kit: kit\dsh-scrub\tools\install.mjs missing.
echo         Keep the kit folder next to this launcher.
pause
exit /b 1