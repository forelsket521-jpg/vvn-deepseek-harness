@echo off
rem ============================================================
rem  vvn setup - run this ONCE after copying the folder to a new PC.
rem
rem  Why this exists: a .lnk stores ABSOLUTE paths, so copying the
rem  shortcut to another machine breaks it (blank icon, dead target).
rem  This rebuilds the shortcut using THIS machine's real path.
rem
rem  ASCII ONLY: cmd.exe reads .cmd as ANSI and CJK bytes break parsing.
rem ============================================================
chcp 65001 >nul
title vvn setup
cd /d "%~dp0"

set "HERE=%~dp0"
if "%HERE:~-1%"=="\" set "HERE=%HERE:~0,-1%"
set "EXE=%HERE%\vvn.exe"

if not exist "%EXE%" goto noexe

echo.
echo ============================================================
echo  vvn setup
echo ============================================================
echo.
echo  Location : %HERE%
echo.

rem Desktop path is resolved by PowerShell: the folder may be localized
rem (e.g. a CJK name) or redirected to OneDrive, so don't hardcode it.
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$desk = [Environment]::GetFolderPath('Desktop'); if (-not $desk) { Write-Host '  [ERROR] no Desktop folder'; exit 1 }; Write-Host ('  Desktop  : ' + $desk); $ws = New-Object -ComObject WScript.Shell; $lnk = Join-Path $desk 'vvn.lnk'; $s = $ws.CreateShortcut($lnk); $s.TargetPath = '%EXE%'; $s.WorkingDirectory = '%HERE%'; $s.IconLocation = '%EXE%,0'; $s.Description = 'vvn - dsh scrub console'; $s.Save(); Write-Host ('  shortcut : ' + $lnk)"
if errorlevel 1 goto nodesktop

echo.
echo  Done. Double-click the vvn icon on your desktop.
echo.
echo  Notes:
echo    - Keep the vvn folder where it is; the shortcut points at it.
echo    - Moved the folder? Run this script again.
echo    - vvn.exe carries its own icon, so it looks right anywhere.
echo.
pause
exit /b 0

:noexe
echo [ERROR] vvn.exe not found next to this script.
echo         Run this from inside the vvn folder.
pause
exit /b 1

:nodesktop
echo.
echo [ERROR] Could not create the shortcut.
echo         Create it manually, pointing at:
echo         %EXE%
pause
exit /b 1