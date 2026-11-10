@echo off
rem Grady Set Go - Playout App
rem Created by Yaniv Grady. Copyright (c) 2026 Yaniv Grady. MIT License (see LICENSE).
rem Stops what runs from this folder and, if you choose, removes the autostart tasks and moves the folder
rem to the Recycle Bin. Asks before it changes anything.
setlocal
rem Administrator rights (checked with fltmc) are needed to stop programs that were started as administrator and to remove autostart tasks.
rem (No parentheses blocks around the folder path: the folder name may contain ")".)
fltmc >nul 2>&1
if not errorlevel 1 goto admin
echo.
echo  Asking Windows for administrator rights ... press Yes in the window that appears.
powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
exit /b
:admin
set "HERE=%~dp0"
cd /d "%TEMP%"
title Grady Set Go - uninstall
where node >nul 2>&1
if errorlevel 1 (
  echo  Node.js was not found, so nothing from this install can be running.
  echo  You can delete this folder.
  pause
  exit /b 1
)
node "%HERE%tools\uninstall.js"
echo.
pause
