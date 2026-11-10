@echo off
setlocal
call "%~dp0scripts\dev.cmd" %*
set "QQ_CODEX_EXIT=%ERRORLEVEL%"
endlocal & exit /b %QQ_CODEX_EXIT%
