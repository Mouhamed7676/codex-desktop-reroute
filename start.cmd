@echo off
REM Double-click launcher for the rerouted Codex desktop app.
REM Everything else lives in run.ps1; this just skips the PowerShell policy prompt.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run.ps1" -Provider nvidia
if errorlevel 1 pause
