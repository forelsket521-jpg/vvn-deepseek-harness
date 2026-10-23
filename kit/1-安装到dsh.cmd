@echo off
chcp 65001 >nul
title dsh-scrub install
cd /d "%~dp0"
call "%~dp0_node.cmd"
if errorlevel 1 exit /b 1

if not exist "%~dp0dsh-scrub\tools\install.mjs" goto missing

echo.
echo ============================================================
echo  Install dsh-scrub into the dsh profile
echo  (panel + scrub tools + model configuration)
echo ============================================================
echo.
echo [1/3] Dry run (nothing is written)...
"%NODE_EXE%" "%~dp0dsh-scrub\tools\install.mjs" --profile desktop
echo.
echo If the dry run reported no error, press any key to install.
echo Closing this window cancels.
pause >nul
echo.
echo [2/3] Writing into the profile...
"%NODE_EXE%" "%~dp0dsh-scrub\tools\install.mjs" --profile desktop --apply
echo.
echo [3/3] Self check...
"%NODE_EXE%" "%~dp0dsh-scrub\tools\plugin-smoke.mjs"
echo.
echo ============================================================
echo  Done. After restarting dsh:
echo    panel   http://127.0.0.1:19387/scrub/
echo    tools   scrub_status / scrub_apply / scrub_revert / scrub_prompt
echo ============================================================
echo.
pause
exit /b 0

:missing
echo [ERROR] Incomplete kit: dsh-scrub\tools\install.mjs missing.
echo         Copy the whole dsh-scrub-kit folder, not a single file.
pause
exit /b 1