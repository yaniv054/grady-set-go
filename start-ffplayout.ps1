# Grady Set Go - Playout App. Created by Yaniv Grady. Copyright (c) 2026 Yaniv Grady.
# Start ffplayout v2.6.0 (staging). Web UI: http://localhost:8787
# Any CLI argument disables the default listener, so -l must be passed explicitly.
# ffplayout reads the PUBLIC environment variable as its HLS folder, and Windows always
# sets PUBLIC=C:\Users\Public. Override it for this process (and ffplayout) only.
#   -Force   start even if ffplayout is already running (normally refused: two copies
#            would fight over the output and the HLS folder)
param([switch]$Force)
$Root = $PSScriptRoot   # install folder (the folder this script is in)
$Cfg = $null
try { $Cfg = Get-Content -Raw -Path (Join-Path $Root 'config.json') -ErrorAction Stop | ConvertFrom-Json } catch { }

$running = @(Get-Process -Name ffplayout -ErrorAction SilentlyContinue)
if ($running.Count -gt 0 -and -not $Force) {
    $pids = ($running | ForEach-Object { $_.Id }) -join ', '
    Write-Host "ffplayout is already running (PID $pids). Not starting a second copy."
    exit 1
}

$env:PUBLIC = "$Root\public"

# Listen address: 127.0.0.1:8787, or the port of a local "engine_url" in config.json.
$listen = '127.0.0.1:8787'
if ($Cfg -and $Cfg.engine_url -match '^https?://(127\.0\.0\.1|localhost):(\d+)') { $listen = "127.0.0.1:$($Matches[2])" }

# Always start with a clean preview: remove leftover HLS files (playlists, segments,
# subtitles) from the previous run so nobody mistakes old preview for what's on air.
Get-ChildItem "$Root\public" -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Extension -in '.m3u8', '.ts', '.m4s', '.vtt' } |
    Remove-Item -Confirm:$false -ErrorAction SilentlyContinue

# Start-Process truncates the redirected log files, so the previous run's output (the
# reason it stopped) is kept first: stderr.log -> stderr.log.1 ... .5, oldest replaced.
# Rotated on EVERY start, not only over 10 MB, so a crash at 03:00 followed by the
# watchdog's restart leaves its evidence in stderr.log.1.
function Rotate-Log([string]$file, [int]$keep = 5) {
    if (-not (Test-Path -LiteralPath $file)) { return }
    try {
        if ((Get-Item -LiteralPath $file).Length -eq 0) { return }
        if (Test-Path -LiteralPath "$file.$keep") { Remove-Item -LiteralPath "$file.$keep" -Force -ErrorAction Stop }
        for ($i = $keep - 1; $i -ge 1; $i--) {
            if (Test-Path -LiteralPath "$file.$i") { Move-Item -LiteralPath "$file.$i" -Destination "$file.$($i + 1)" -ErrorAction Stop }
        }
        Move-Item -LiteralPath $file -Destination "$file.1" -ErrorAction Stop
    } catch { Write-Host "Could not rotate ${file}: $($_.Exception.Message)" }
}
Rotate-Log "$Root\logs\stderr.log"
Rotate-Log "$Root\logs\stdout.log"

Start-Process "$Root\app\bin\ffplayout.exe" `
    -ArgumentList '--db',"`"$Root\data\ffplayout.db`"",'--logs',"`"$Root\logs`"",'-l',$listen `
    -WorkingDirectory "$Root\app" `
    -RedirectStandardOutput "$Root\logs\stdout.log" `
    -RedirectStandardError "$Root\logs\stderr.log" `
    -WindowStyle Hidden
