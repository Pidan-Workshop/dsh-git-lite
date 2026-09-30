@echo off
rem dsh-git-lite installer for Windows (thin wrapper over install.ps1).
rem
rem Why the wrapper: this machine's execution policy is AllSigned, so invoking a
rem local .ps1 directly fails with "not digitally signed". Passing
rem -ExecutionPolicy Bypass here (process scope only) keeps the user out of that.
rem
rem Usage:
rem   install.cmd                          -> desktop profile, link: this repo
rem   install.cmd -Profile web             -> web profile
rem   install.cmd -Spec dsh-git-lite       -> install from npm instead
rem   install.cmd -DryRun                  -> print the command only
setlocal
set "DSH_PS=powershell"
where pwsh >nul 2>nul && set "DSH_PS=pwsh"
"%DSH_PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
exit /b %errorlevel%
