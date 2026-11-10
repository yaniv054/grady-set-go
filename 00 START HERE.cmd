@echo off
rem Grady Set Go - Playout App
rem Created by Yaniv Grady. Copyright (c) 2026 Yaniv Grady. MIT License (see LICENSE).
rem One-click installer for Windows 10/11: installs Node.js, FFmpeg and VLC with winget,
rem downloads ffplayout, starts everything and opens the panel. Safe to run again.
setlocal
cd /d "%~dp0"
title Grady Set Go - install
echo.
echo  Grady Set Go - Playout App: installing what the panel needs
echo.

rem Already installed on this PC? Then stop here and point to the update (nothing is installed or started).
where node >nul 2>&1
if errorlevel 1 goto noexisting
node "%~dp0tools\install.js" --check-existing
if errorlevel 2 ( echo. & pause & exit /b 2 )
:noexisting

where winget >nul 2>&1
if errorlevel 1 (
  echo  winget was not found. Update "App Installer" in the Microsoft Store, then run this again.
  echo  Or install Node.js ^(nodejs.org^) and FFmpeg by hand and run:  node tools\install.js
  pause
  exit /b 1
)

where node >nul 2>&1
if errorlevel 1 (
  echo  Installing Node.js LTS ...
  winget install --id OpenJS.NodeJS.LTS -e --silent --accept-package-agreements --accept-source-agreements
)
where ffprobe >nul 2>&1
if errorlevel 1 (
  echo  Installing FFmpeg ...
  winget install --id Gyan.FFmpeg -e --silent --accept-package-agreements --accept-source-agreements
)
if not exist "%ProgramFiles%\VideoLAN\VLC\vlc.exe" (
  echo  Installing VLC ^(optional^) ...
  winget install --id VideoLAN.VLC -e --silent --accept-package-agreements --accept-source-agreements
)

rem The programs just installed are not on this window's PATH yet: read the PATH again from Windows.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$env:Path=[Environment]::GetEnvironmentVariable('Path','Machine')+';'+[Environment]::GetEnvironmentVariable('Path','User'); $n=(Get-Command node -ErrorAction SilentlyContinue); if(-not $n){ Write-Host 'Node.js is still not found. Close this window, open a new one and run 00 START HERE.cmd again.'; exit 1 }; & node '%~dp0tools\install.js'"
if errorlevel 1 ( echo. & echo  The installer stopped. Read the message above. & pause & exit /b 1 )
exit /b 0
