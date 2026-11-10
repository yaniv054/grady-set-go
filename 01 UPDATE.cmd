@echo off
rem Grady Set Go - Playout App
rem Created by Yaniv Grady. Copyright (c) 2026 Yaniv Grady. MIT License (see LICENSE).
rem Updates an existing install to the version in this folder. Settings and data are kept; the old
rem program files are backed up and put back automatically if the new version does not start.
setlocal
cd /d "%~dp0"
title Grady Set Go - update
echo.
echo  Grady Set Go - Playout App: update an existing install
echo.
where node >nul 2>&1
if errorlevel 1 (
  echo  Node.js was not found. This PC has no working install to update.
  echo  To install for the first time, run "00 START HERE.cmd".
  pause
  exit /b 1
)
node "%~dp0tools\update.js"
if errorlevel 1 ( echo. ^& echo  The update did not finish. Read the message above. Nothing was lost: the old version is in the backup folder. ^& pause ^& exit /b 1 )
echo.
pause
