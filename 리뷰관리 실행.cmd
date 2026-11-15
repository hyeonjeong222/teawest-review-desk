@echo off
cd /d "%~dp0"
if exist "%~dp0runtime\node.exe" (
  "%~dp0runtime\node.exe" --env-file-if-exists=.env scripts/launch.mjs
) else (
  node --env-file-if-exists=.env scripts/launch.mjs
)
if errorlevel 1 pause
