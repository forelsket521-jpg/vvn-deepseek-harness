@echo off
rem Locate node.exe: prefer the runtime bundled with dsh, then PATH.
set "NODE_EXE="

if exist "C:\deepseek\resources\runtime\primary-runtime\dependencies\node\bin\node.exe" set "NODE_EXE=C:\deepseek\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
if not defined NODE_EXE if exist "%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" set "NODE_EXE=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE_EXE for %%I in (node.exe) do if not defined NODE_EXE set "NODE_EXE=%%~$PATH:I"

if not defined NODE_EXE (
  echo [ERROR] node.exe not found.
  echo         Install Node.js, or add its folder to PATH.
  pause
  exit /b 1
)
exit /b 0