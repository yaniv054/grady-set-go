# Grady Set Go - Playout App. Created by Yaniv Grady. Copyright (c) 2026 Yaniv Grady.
# Looks up the credits of songs found in clips (MusicBrainz, then Wikidata).
#   powershell -ExecutionPolicy Bypass -File <install folder>\tools\credits\lookup-credits.ps1
# Options:
#   -Clip c0123456789abcde   only this clip
#   -Force                   look up again songs that were looked up before (not confirmed ones)
#   -Max 200                 at most this many songs (1 request per second; answers are cached 30 days)
#   -Until 07:00             stop at this time
# Never confirms anything: suggestions are confirmed by a person in Needs attention > Songs.
# Exit code 3: "format changed" (send the log). Exit code 4: provider busy, run again later.
# Log: <install folder>\logs\lookup-credits.log
param([string]$Clip = '', [switch]$Force, [int]$Max = 0, [string]$Until = '')
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path   # install folder
$a = @("`"$Root\tools\credits\lookup-credits.js`"")   # data and library paths come from config.json
if ($Clip) { $a += @('--clip', $Clip) }
if ($Force) { $a += '--force' }
if ($Max -gt 0) { $a += @('--max', "$Max") }
if ($Until) { $a += @('--until', $Until) }
# Non-Latin names in the console and the log: UTF-8 both ways.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$log = "$Root\logs\lookup-credits.log"
& node @a 2>&1 | ForEach-Object { $line = "$_"; Write-Output $line; Add-Content -LiteralPath $log -Value $line -Encoding UTF8 }
exit $LASTEXITCODE
