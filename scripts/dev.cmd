@echo off
setlocal
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0dev.ps1" %*
set "QQ_CODEX_EXIT=%ERRORLEVEL%"
endlocal & exit /b %QQ_CODEX_EXIT%
