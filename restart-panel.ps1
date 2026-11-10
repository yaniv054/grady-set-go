# Grady Set Go - Playout App. Created by Yaniv Grady. Copyright (c) 2026 Yaniv Grady.
# Restart only the panel (node panel\server.js) to load new panel code.
# ffplayout and any running stream are not touched.
# The panel started at boot runs elevated: run this in PowerShell opened as Administrator,
# otherwise Windows does not let it stop the old panel (the script says so and changes nothing).
#
# A camera sent to the live input (Live input > Capture devices) runs in its own ffmpeg and
# keeps sending while the panel restarts; the new panel shows it with a Stop button. To stop
# it here as well:  restart-panel.ps1 -StopCapture
# (only the recorded process is stopped, and only if it is still ffmpeg.exe).
param([switch]$StopCapture)
$Root = $PSScriptRoot   # install folder (the folder this script is in)
$Cfg = $null
try { $Cfg = Get-Content -Raw -Path (Join-Path $Root 'config.json') -ErrorAction Stop | ConvertFrom-Json } catch { }

# The capture bridge recorded by the panel (data\capture-bridge.json). It counts only when the
# process with that id is ffmpeg.exe, was created at the recorded start time (within 2 s) and
# its command line pushes to the recorded live input (-f flv or -f mpegts and its host:port).
# ffplayout's own ffmpeg processes (its child processes, or ones that listen) never count.
$captureRecord = "$Root\data\capture-bridge.json"
function Get-CaptureBridge {
    if (-not (Test-Path -LiteralPath $captureRecord)) { return $null }
    try { $rec = Get-Content -LiteralPath $captureRecord -Raw | ConvertFrom-Json } catch { return $null }
    if (-not $rec.pid) { return $null }
    $p = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$rec.pid)" -ErrorAction SilentlyContinue
    if (-not $p) {
        # The recorded process is gone: the record is moved aside (kept).
        $stampText = Get-Date -Format 'yyyy-MM-ddTHH-mm-ss'
        try { Move-Item -LiteralPath $captureRecord -Destination "$captureRecord.ended-$stampText" -ErrorAction Stop } catch { }
        return $null
    }
    if ($p.Name -ne 'ffmpeg.exe') { return $null }
    if ($rec.os_start) { $want = [DateTimeOffset]::FromUnixTimeMilliseconds([long]$rec.os_start).UtcDateTime }
    else { $want = ([DateTime]::Parse($rec.started)).ToUniversalTime() }
    $diff = [Math]::Abs(($p.CreationDate.ToUniversalTime() - $want).TotalSeconds)
    if ($diff -gt 2) { return $null }
    $cmd = [string]$p.CommandLine
    if ($cmd -notmatch '-f (flv|mpegts)\b' -or $cmd -match '-listen\b') { return $null }
    if ($rec.hostport -and $cmd.IndexOf([string]$rec.hostport) -lt 0) { return $null }
    $parent = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$p.ParentProcessId)" -ErrorAction SilentlyContinue
    if ($parent -and $parent.Name -like 'ffplayout*') { return $null }
    return $p
}
$bridge = Get-CaptureBridge
if ($bridge) {
    if ($StopCapture) {
        Stop-Process -Id $bridge.ProcessId -Force -ErrorAction SilentlyContinue
        Wait-Process -Id $bridge.ProcessId -Timeout 5 -ErrorAction SilentlyContinue
        if (Get-Process -Id $bridge.ProcessId -ErrorAction SilentlyContinue) {
            Write-Warning "The camera sent to the live input (ffmpeg process $($bridge.ProcessId)) is still running: Windows did not let this PowerShell stop it. Run this script in PowerShell opened as Administrator."
        } else {
            Write-Host "Stopped the camera sent to the live input (ffmpeg process $($bridge.ProcessId))."
            $stampText = Get-Date -Format 'yyyy-MM-ddTHH-mm-ss'
            try { Move-Item -LiteralPath $captureRecord -Destination "$captureRecord.ended-$stampText" -ErrorAction Stop } catch { }
        }
    } else {
        Write-Warning "A camera is still being sent to the live input (ffmpeg process $($bridge.ProcessId)). It keeps sending; the restarted panel shows it with a Stop button. To stop it now, run this script with -StopCapture."
    }
}

# The panel is whatever listens on port 8790 (the command line of an elevated process is not
# visible to a normal PowerShell, so it is found by its port, and by command line as a fallback).
function Get-PanelPids {
    $ids = @()
    try { $ids += @(Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 8790 -State Listen -ErrorAction Stop | ForEach-Object { $_.OwningProcess }) } catch { }
    $ids += @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
        Where-Object { $_.CommandLine -like '*Playout\panel\server.js*' } | ForEach-Object { $_.ProcessId })
    return @($ids | Where-Object { $_ } | Sort-Object -Unique)
}

# Does something answer on 8790? (Independent of process ids: an elevated panel can be
# invisible to a normal PowerShell, both its command line and its socket owner.)
function Test-PanelUp {
    try { $null = Invoke-WebRequest -Uri 'http://127.0.0.1:8790/' -UseBasicParsing -TimeoutSec 3; return $true }
    catch { return [bool]$_.Exception.Response }
}

$old = Get-PanelPids
foreach ($id in $old) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }
if ($old.Count -gt 0) { Wait-Process -Id $old -Timeout 10 -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 500
if (Test-PanelUp) {
    $left = @(Get-PanelPids | Where-Object { $old -contains $_ })
    if ($left.Count -gt 0) { Write-Host "The running panel (process $($left -join ', ')) could not be stopped: Windows refused." }
    else { Write-Host 'A panel is still answering on http://127.0.0.1:8790 but this PowerShell cannot see or stop it (it runs elevated, from the boot task).' }
    Write-Host 'Open PowerShell as Administrator (right-click > Run as administrator) and run this script again,'
    Write-Host 'or use "Restart panel" on the System settings page (the panel exits by itself; the boot watchdog starts it again).'
    Write-Host 'Nothing was changed; the old panel keeps running.'
    exit 1
}

& "$Root\start-panel.ps1"

# Report success only when a NEW panel answers on 8790.
$ok = $false
for ($i = 0; $i -lt 15; $i++) {
    Start-Sleep -Seconds 1
    $now = Get-PanelPids
    if (-not ($now | Where-Object { $old -notcontains $_ })) { continue }
    try {
        $null = Invoke-WebRequest -Uri 'http://127.0.0.1:8790/' -UseBasicParsing -TimeoutSec 3
        $ok = $true
        break
    } catch {
        # A reply with an HTTP error status still means the panel is up.
        if ($_.Exception.Response) { $ok = $true; break }
    }
}
if ($ok) {
    Write-Host 'Panel restarted. Open http://127.0.0.1:8790 and press Ctrl+F5.'
    exit 0
}
Write-Host 'The new panel did not answer on http://127.0.0.1:8790 within 15 seconds. Last lines of <install folder>\logs\panel.err.log:'
if (Test-Path "$Root\logs\panel.err.log") {
    Get-Content -Path '<install folder>\logs\panel.err.log' -Tail 20 | ForEach-Object { Write-Host $_ }
} else {
    Write-Host '(no panel.err.log)'
}
exit 1
