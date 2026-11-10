# Grady Set Go - Playout App. Created by Yaniv Grady. Copyright (c) 2026 Yaniv Grady.
# One-time setup: the channel comes up by itself when the PC starts.
# Run once, in PowerShell opened as Administrator:
#   powershell -ExecutionPolicy Bypass -File <install folder>\install-autostart.ps1
# To remove everything it set up:
#   powershell -ExecutionPolicy Bypass -File <install folder>\install-autostart.ps1 -Remove
#
# It runs boot-playout.ps1 (share wait, ffplayout, panel, resume, then a watchdog) through
# a scheduled task "Playout boot". Whether the broadcast is started again after a restart
# is decided on the panel's System settings page (on_boot: continue / stop).
#   Account WITHOUT a password (Windows signs in by itself at start): the task runs when
#   this account signs in, so everything is in your session (VLC/Explorer open on screen).
#   Account WITH a password: the task runs at PC start, before anyone signs in, and a
#   second task "Playout panel" moves the panel into your session when you sign in.
# It also sets the power plan so the PC never sleeps or hibernates on mains power.
param([switch]$Remove)
$Root = $PSScriptRoot   # install folder (the folder this script is in)
$Cfg = $null
try { $Cfg = Get-Content -Raw -Path (Join-Path $Root 'config.json') -ErrorAction Stop | ConvertFrom-Json } catch { }

$ErrorActionPreference = 'Stop'
$boot = 'Playout boot'
$logon = 'Playout panel'

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { Write-Host 'Run this in PowerShell opened as Administrator (right-click > Run as administrator).'; exit 1 }

if ($Remove) {
    foreach ($t in $boot, $logon) { Unregister-ScheduledTask -TaskName $t -Confirm:$false -ErrorAction SilentlyContinue }
    Write-Host 'Removed the two scheduled tasks. ffplayout and the panel keep running until the next restart.'
    exit 0
}

$user = "$env:USERDOMAIN\$env:USERNAME"
Write-Host "The tasks run as $user (this account can read the media share)."
Write-Host 'Windows asks for this account''s password. If the account has no password, leave it empty and press OK.'
$win = Get-Credential -UserName $user -Message 'Windows password for this account (empty if none)'
if (-not $win) { Write-Host 'Cancelled.'; exit 1 }
$pw = $win.GetNetworkCredential().Password

$ps = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"

# The boot task runs for as long as the PC is on (the watchdog loop).
$a1 = New-ScheduledTaskAction -Execute $ps -Argument '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $Root 'boot-playout.ps1') + '"' -WorkingDirectory $Root
$s1 = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew

if (-not $pw) {
    # No password: Windows signs this account in by itself at start, so the task runs
    # at sign-in, in the visible session. No second task is needed.
    $t1 = New-ScheduledTaskTrigger -AtLogOn -User $user
    $t1.Delay = 'PT20S'
    $p1 = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Highest
    Register-ScheduledTask -TaskName $boot -Action $a1 -Trigger $t1 -Settings $s1 -Principal $p1 -Force | Out-Null
    Unregister-ScheduledTask -TaskName $logon -Confirm:$false -ErrorAction SilentlyContinue
    powercfg /change standby-timeout-ac 0
    powercfg /change hibernate-timeout-ac 0
    Write-Host ''
    Write-Host 'Done. Scheduled task "Playout boot" runs when this account signs in (it has no password, so Windows signs in by itself at start).'
    Write-Host 'Still needed once, in the PC''s BIOS/UEFI: set "Restore on AC power loss" (or "AC recovery") to "Power On",'
    Write-Host 'so the PC switches itself on when the electricity comes back.'
    Write-Host 'Test: restart the PC, check that Windows reaches the desktop by itself, wait 2 minutes, then check <install folder>\logs\boot.log.'
    exit 0
}

# With a password: run at PC start, before anyone signs in.
$t1 = New-ScheduledTaskTrigger -AtStartup
$t1.Delay = 'PT30S'
Register-ScheduledTask -TaskName $boot -Action $a1 -Trigger $t1 -Settings $s1 -User $user -Password $pw -RunLevel Highest -Force | Out-Null

# Second task: when this account signs in, move the panel into the visible session.
$a2 = New-ScheduledTaskAction -Execute $ps -Argument '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $Root 'restart-panel.ps1') + '"' -WorkingDirectory $Root
$t2 = New-ScheduledTaskTrigger -AtLogOn -User $user
$t2.Delay = 'PT20S'
$s2 = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -MultipleInstances IgnoreNew
$p2 = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Highest
Register-ScheduledTask -TaskName $logon -Action $a2 -Trigger $t2 -Settings $s2 -Principal $p2 -Force | Out-Null

# Never sleep or hibernate on mains power.
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0

Write-Host ''
Write-Host 'Done. Two scheduled tasks are installed: "Playout boot" and "Playout panel".'
Write-Host 'Still needed once, in the PC''s BIOS/UEFI: set "Restore on AC power loss" (or "AC recovery") to "Power On",'
Write-Host 'so the PC switches itself on when the electricity comes back.'
Write-Host 'Test: restart the PC, wait 2 minutes without signing in, then check <install folder>\logs\boot.log.'
