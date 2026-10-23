@echo off
rem Restore dsh host files from a snapshot.
rem   no args          interactive
rem   <snapshot-id>   restore it
rem   <snapshot-id> --dry   report only
rem ASCII only: cmd.exe reads .cmd as ANSI and mangles CJK.
chcp 65001 >nul
title vvn restore host files
cd /d "%~dp0"
call "%~dp0_node.cmd"
if errorlevel 1 exit /b 1

set "DSH_SURFACE=desktop"
set "DSH_HOME=%USERPROFILE%\.dsh"
set "PURGE=%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-purge"
set "SNAP_JS=%PURGE%\lib\snapshot.js"

if not exist "%PURGE%\bin\dsh-purge.js" goto nopurge
if not exist "%SNAP_JS%" goto nomodule

set "SNAPID=%~1"
set "MODE=%~2"
if not "%SNAPID%"=="" goto haveid

echo.
echo ============================================================
echo  Available snapshots (auto-created before scrub, last 6 kept)
echo ============================================================
"%NODE_EXE%" --input-type=module -e "const m = await import('file:///' + process.env.SNAP_JS.replace(/\\/g, '/')); const list = m.listSnapshots(process.env.USERPROFILE + '/.dsh'); if (!list.length) { console.log('  (none yet - the first scrub creates one)'); } else { for (const s of list) console.log('  ' + s.id + '   ' + s.files + ' files   ' + (s.bytes / 1048576).toFixed(1) + ' MB   ' + s.label); }"
echo.
echo  Snapshot id to restore (Enter = cancel):
set "SNAPID="
set /p SNAPID=
if "%SNAPID%"=="" goto cancel

:haveid
echo.
echo  Snapshot: %SNAPID%   mode: %MODE%
echo  This overwrites dsh host files with the snapshot copy.
echo  Press any key to continue, close the window to cancel.
pause >nul

"%NODE_EXE%" --input-type=module -e "const m = await import('file:///' + process.env.SNAP_JS.replace(/\\/g, '/')); const home = process.env.USERPROFILE + '/.dsh'; const id = (process.env.SNAPID || '').trim(); const dry = (process.env.MODE || '') === '--dry'; if (!id) { console.log('CANCELLED: no snapshot id given.'); process.exit(2); } const known = m.listSnapshots(home).map((s) => s.id); if (!known.includes(id)) { console.log('ABORT: unknown snapshot id: ' + id); console.log('known: ' + known.join(', ')); process.exit(3); } if (dry) { console.log('DRY RUN: would restore ' + id + ' - no files changed.'); process.exit(4); } const r = m.restoreSnapshot({ dshHome: home, id }); console.log('restored ' + r.restored.length + ' files; skipped ' + r.skipped.length + '; missing ' + r.missing.length); for (const s of r.skipped) console.log('  skipped: ' + s.path + ' - ' + s.reason);"
set "RC=%ERRORLEVEL%"

if "%RC%"=="2" goto cancel
if "%RC%"=="3" goto badid
if "%RC%"=="4" goto dryok
if not "%RC%"=="0" goto failed

echo.
echo  Done. Restart dsh to take effect.
echo.
pause
exit /b 0

:dryok
echo.
echo  Dry run finished - nothing was changed.
echo  Drop --dry to actually restore.
echo.
pause
exit /b 0

:cancel
echo Cancelled - nothing was changed.
pause
exit /b 0

:badid
echo No files were changed.
pause
exit /b 1

:failed
echo Restore failed (exit %RC%). No changes reported as done.
pause
exit /b 1

:nomodule
echo [ERROR] snapshot module missing: %SNAP_JS%
echo         Copy kit\dsh-purge-patches\snapshot.v1.js to lib\snapshot.js and retry.
pause
exit /b 1

:nopurge
echo [ERROR] dsh-purge not found at %PURGE%
echo         Nothing to restore for this profile.
pause
exit /b 1