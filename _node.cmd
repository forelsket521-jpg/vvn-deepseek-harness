@echo off
rem Locate node.exe without hardcoding a drive letter.
rem Order: dsh bundled runtime (from registry) -> user runtime -> system node -> PATH.
set "NODE_EXE="

rem 1) Ask the uninstall registry where dsh lives, then look for its bundled node.
set "DSH_ROOT="
for /f "tokens=2,*" %%A in ('reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall" /s /v InstallLocation 2^>nul ^| findstr /i "InstallLocation"') do (
  call :try_root "%%B"
)
for /f "tokens=2,*" %%A in ('reg query "HKLM\Software\Microsoft\Windows\CurrentVersion\Uninstall" /s /v InstallLocation 2^>nul ^| findstr /i "InstallLocation"') do (
  call :try_root "%%B"
)
for /f "tokens=2,*" %%A in ('reg query "HKLM\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall" /s /v InstallLocation 2^>nul ^| findstr /i "InstallLocation"') do (
  call :try_root "%%B"
)

rem 2) User-level runtime under the dsh home.
if not defined NODE_EXE if exist "%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" set "NODE_EXE=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"

rem 3) System-wide node.
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE_EXE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"

rem 4) PATH.
if not defined NODE_EXE for %%I in (node.exe) do if not defined NODE_EXE set "NODE_EXE=%%~$PATH:I"

if not defined NODE_EXE (
  echo [ERROR] node.exe not found.
  echo         Install Node.js, or run the DeepSeek Harness installer once.
  pause
  exit /b 1
)
exit /b 0

:try_root
rem %~1 = a candidate install root; accept it only if it really looks like dsh.
set "_r=%~1"
if "%_r%"=="" exit /b 0
if not exist "%_r%\" exit /b 0
if exist "%_r%\resources\runtime\primary-runtime\dependencies\node\bin\node.exe" (
  if not defined NODE_EXE set "NODE_EXE=%_r%\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
  exit /b 0
)
if exist "%_r%\resources\app\dsh" if not defined DSH_ROOT set "DSH_ROOT=%_r%"
exit /b 0