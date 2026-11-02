@echo off
REM Larp mode: the picker shows OpenAI models, the wire goes to NVIDIA NIM.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run.ps1" -Provider nvidia -Larp
if errorlevel 1 pause
