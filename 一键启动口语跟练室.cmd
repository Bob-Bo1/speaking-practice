@echo off
setlocal
set "LAUNCHER=%~dp0apps\speaking-practice\scripts\start-practice.ps1"
if not exist "%LAUNCHER%" set "LAUNCHER=%~dp0app\scripts\start-practice.ps1"

where powershell.exe >nul 2>&1
if errorlevel 1 (
  echo Windows PowerShell ^(powershell.exe^) was not found.
  echo Please open Codex and ask it to repair the launcher.
  pause
  exit /b 1
)

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%LAUNCHER%"
if errorlevel 1 (
  echo.
  echo 口语跟练室页面启动失败。
  echo See the message above, then press any key to close this window.
  pause >nul
  exit /b 1
)

exit /b 0
