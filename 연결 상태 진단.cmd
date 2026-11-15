@echo off
chcp 65001 >nul
cd /d "%~dp0"
if exist "%~dp0runtime\node.exe" (
  "%~dp0runtime\node.exe" --env-file-if-exists=.env scripts/diagnose-connection.mjs
) else (
  node --env-file-if-exists=.env scripts/diagnose-connection.mjs
)
echo.
pause
