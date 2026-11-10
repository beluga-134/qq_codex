@echo off
setlocal
cd /d "%~dp0"
if exist ".tooling\windows\portable-git\cmd\git.exe" (
  set "GITCMD=.tooling\windows\portable-git\cmd\git.exe"
) else (
  set "GITCMD=C:\Program Files\Git\bin\git.exe"
)
"%GITCMD%" push https://github.com/beluga-134/qq_codex.git 2.0
endlocal & exit /b %ERRORLEVEL%
