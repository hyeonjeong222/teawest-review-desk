@echo off
cd /d "%~dp0"
node --env-file-if-exists=.env scripts/launch.mjs
if errorlevel 1 pause
