# Grady Set Go - Playout App. Created by Yaniv Grady. Copyright (c) 2026 Yaniv Grady.
# Brings the channel up when the PC starts, and keeps it up.
# Run by the scheduled task "Playout boot" (installed by install-autostart.ps1); not
# meant to be started by hand. Log: <install folder>\logs\boot.log
#
# 1. waits up to 5 minutes for the media share (playlists play from it)
# 2. starts ffplayout and waits until it answers
# 3. starts the panel
# 4. asks the panel to resume the broadcast (POST /local/system/resume): the panel starts
#    the channel when System settings say "continue" and it was on air before the restart
# 5. checks every minute: if ffplayout or the panel has stopped (or ffplayout is running
#    but not answering for 3 checks), starts it again, then asks the panel to resume again
#
# Maintenance: create the file <install folder>\data\WATCHDOG_OFF to stop step 5 (nothing is
# restarted while it exists); delete it to resume.

$Root = $PSScriptRoot   # install folder (the folder this script is in)
$Cfg = $null
try { $Cfg = Get-Content -Raw -Path (Join-Path $Root 'config.json') -ErrorAction Stop | ConvertFrom-Json } catch { }
$ErrorActionPreference = 'Continue'
$log = "$Root\logs\boot.log"
$share = $(if ($Cfg -and $Cfg.media_root) { [string]$Cfg.media_root } else { '' })
$pause = "$Root\data\WATCHDOG_OFF"
$engine = 'http://127.0.0.1:8787'
$panel = 'http://127.0.0.1:8790/'

function Write-Log([string]$text) {
    $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $text
    try { Add-Content -Path $log -Value $line -Encoding UTF8 } catch { }
}

# Any HTTP reply (even an error status) means the server is up.
function Test-Url([string]$url) {
    try { $null = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 5; return $true }
    catch { return [bool]$_.Exception.Response }
}

function Wait-Url([string]$url, [int]$seconds) {
    for ($i = 0; $i -lt $seconds; $i += 2) {
        if (Test-Url $url) { return $true }
        Start-Sleep -Seconds 2
    }
    return $false
}

function Start-Engine {
    Write-Log 'ffplayout is not running: starting it'
    & "$Root\start-ffplayout.ps1" | ForEach-Object { Write-Log "  $_" }
    if (Wait-Url "$engine/api/setup" 60) { Write-Log 'ffplayout answers'; return $true }
    Write-Log 'ffplayout did not answer within 60 s'
    return $false
}

# Asks the panel to resume the broadcast per System settings (the panel decides and logs
# why). The answer is logged here; no panel = nothing to do.
# Returns $true when the panel answered (whatever it decided); $false when it could not be
# reached, so the caller can try again later.
function Resume-Broadcast([string]$why) {
    try {
        $body = '{"why":"' + $why + '"}'
        $r = Invoke-RestMethod -Uri "${panel}local/system/resume" -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 60 -ErrorAction Stop
        Write-Log ("resume ({0}): {1} - {2}" -f $why, $r.action, $r.detail)
        return $true
    } catch { Write-Log ("resume ({0}) failed: {1}" -f $why, $_.Exception.Message); return $false }
}

# ffplayout's own ffmpeg processes (encoder, decoder, ingest) are ended with it, so a new
# engine does not fight the old encoder for the stream endpoint or the HLS folder.
function Stop-EngineTree($procs) {
    foreach ($p in @($procs)) {
        $kids = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $($p.Id)" -ErrorAction SilentlyContinue)
        foreach ($k in $kids) { try { Stop-Process -Id $k.ProcessId -Force -ErrorAction Stop } catch { } }
        try { Stop-Process -Id $p.Id -Force -ErrorAction Stop } catch { Write-Log ("could not end ffplayout {0}: {1}" -f $p.Id, $_.Exception.Message) }
    }
}

Write-Log '--- PC started: starting ffplayout and the panel (the broadcast is started by hand)'

if ($share) {
    for ($i = 0; $i -lt 60 -and -not (Test-Path -LiteralPath $share); $i++) { Start-Sleep -Seconds 5 }
    if (Test-Path -LiteralPath $share) { Write-Log 'media folder reachable' }
    else { Write-Log 'media folder NOT reachable after 5 minutes; starting anyway' }
} else { Write-Log 'no media folder configured yet (open the panel setup screen); starting anyway' }

if (Get-Process -Name ffplayout -ErrorAction SilentlyContinue) { Write-Log 'ffplayout already running' }
else { $null = Start-Engine }

if (Test-Url $panel) { Write-Log 'panel already running' }
else {
    Write-Log 'starting the panel'
    & "$Root\start-panel.ps1"
    if (Wait-Url $panel 30) { Write-Log 'panel answers' } else { Write-Log 'panel did not answer within 30 s (see logs\panel.err.log)' }
}

# The engine needs a moment after answering before it accepts a start command. The panel may
# still be starting (a cold boot with the antivirus busy): tried every 30 s for up to 10 minutes.
Start-Sleep -Seconds 5
$resumed = $false
for ($i = 0; $i -lt 20 -and -not $resumed; $i++) {
    if ($i -gt 0) { Start-Sleep -Seconds 30 }
    $resumed = Resume-Broadcast 'boot'
}
if (-not $resumed) { Write-Log 'resume (boot): the panel never answered; the watchdog tries again when it starts the panel' }

# Watch: a stopped part is started again. The panel must miss two checks in a row, so a
# restart-panel.ps1 in progress is not interfered with. An engine process that is alive
# but does not answer HTTP for three checks in a row is treated as hung: ended and started.
$panelMisses = 0
$engineMisses = 0
while ($true) {
    Start-Sleep -Seconds 60
    if (Test-Path -LiteralPath $pause) { continue }
    $engineProc = Get-Process -Name ffplayout -ErrorAction SilentlyContinue
    if (-not $engineProc) {
        $engineMisses = 0
        if (Start-Engine) { Start-Sleep -Seconds 5; $null = Resume-Broadcast 'engine restart' }
    } elseif (Test-Url "$engine/api/setup") {
        $engineMisses = 0
    } else {
        $engineMisses++
        if ($engineMisses -ge 3) {
            Write-Log ("ffplayout (PID {0}) is running but has not answered for 3 checks: ending it" -f (($engineProc | ForEach-Object { $_.Id }) -join ', '))
            Stop-EngineTree $engineProc
            Start-Sleep -Seconds 3
            $engineMisses = 0
            if (Start-Engine) { Start-Sleep -Seconds 5; $null = Resume-Broadcast 'engine hung' }
        }
    }
    if (Test-Url $panel) { $panelMisses = 0; continue }
    $panelMisses++
    if ($panelMisses -ge 2) {
        Write-Log 'the panel is not answering: starting it'
        & "$Root\start-panel.ps1"
        $panelMisses = 0
        # A boot whose resume never reached the panel gets its chance now.
        if (-not $resumed -and (Wait-Url $panel 60)) { Start-Sleep -Seconds 3; $resumed = Resume-Broadcast 'panel restart after boot' }
    }
}
