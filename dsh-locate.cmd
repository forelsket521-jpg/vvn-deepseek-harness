@echo off
rem Report where dsh is, and whether everything vvn needs is present.
rem ASCII ONLY: cmd.exe reads .cmd as ANSI, CJK bytes break line parsing.
rem No hardcoded drive letters: everything comes from the registry or probing.
chcp 65001 >nul
title vvn locate
cd /d "%~dp0"
call "%~dp0_node.cmd"
if errorlevel 1 exit /b 1

set "DSH_SURFACE=desktop"
set "DSH_HOME=%USERPROFILE%\.dsh"

echo.
echo ============================================================
echo  Where is dsh
echo ============================================================
echo.
echo  node
echo    %NODE_EXE%
echo.

set "FOUND_ROOT="
set "EXE_FOUND="
rem Other software in the registry can have brackets / unicode in its path
rem (e.g. a NIC driver named "MW150UH(freedriver)2.0"). Feeding that straight
rem into `if exist` breaks cmd parsing, so use delayed expansion + a filter.
setlocal enabledelayedexpansion
for /f "tokens=2,*" %%A in ('reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall" /s /v InstallLocation 2^>nul ^| findstr /i "InstallLocation"') do (
  set "_c=%%B"
  call :probe "!_c!"
)
for /f "tokens=2,*" %%A in ('reg query "HKLM\Software\Microsoft\Windows\CurrentVersion\Uninstall" /s /v InstallLocation 2^>nul ^| findstr /i "InstallLocation"') do (
  set "_c=%%B"
  call :probe "!_c!"
)
for /f "tokens=2,*" %%A in ('reg query "HKLM\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall" /s /v InstallLocation 2^>nul ^| findstr /i "InstallLocation"') do (
  set "_c=%%B"
  call :probe "!_c!"
)
endlocal & set "FOUND_ROOT=%FOUND_ROOT%" & set "EXE_FOUND=%EXE_FOUND%"

if not defined FOUND_ROOT echo  [!] No DeepSeek Harness install found in the registry.
echo.
echo  dsh home
echo    %DSH_HOME%
echo.
if exist "%DSH_HOME%\profiles\desktop\node_modules\dsh-purge\bin\dsh-purge.js" (
  echo  dsh-purge  installed
) else (
  echo  dsh-purge  not installed
)
if exist "%~dp0kit\dsh-scrub\bin\scrub.js" (
  echo  tool kit   complete
) else (
  echo  tool kit   INCOMPLETE - copy the whole vvn folder
)
echo.
pause
exit /b 0

:probe
rem %~1 = candidate install root. Only accept dirs that really look like dsh.
rem Skip anything with brackets: those break `if exist` parsing.
set "_r=%~1"
if "%_r%"=="" exit /b 0
echo %_r% | findstr /r "[()]" >nul && exit /b 0
if not exist "%_r%\" exit /b 0
if exist "%_r%\resources\app\dsh\node_modules\@deepseek-ai" (
  echo  install root
  echo    %_r%
  echo    host dir: %_r%\resources\app\dsh\node_modules\@deepseek-ai
  if not defined FOUND_ROOT set "FOUND_ROOT=%_r%"
)
if exist "%_r%\DeepSeek Harness.exe" if not defined EXE_FOUND (
  echo    launcher : %_r%\DeepSeek Harness.exe
  set "EXE_FOUND=1"
)
exit /b 0