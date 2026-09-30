@echo off
rem dsh-git-lite uninstaller for Windows (thin wrapper over uninstall.ps1).
rem
rem Usage:
rem   uninstall.cmd                  -> remove from the desktop profile
rem   uninstall.cmd -Profile web     -> remove from the web profile
rem   uninstall.cmd -DryRun          -> print the command only
setlocal
set "DSH_PS=powershell"
where pwsh >nul 2>nul && set "DSH_PS=pwsh"
"%DSH_PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall.ps1" %*
exit /b %errorlevel%
