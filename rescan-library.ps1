# Grady Set Go - Playout App. Created by Yaniv Grady. Copyright (c) 2026 Yaniv Grady.
# Rescan the media folder and update <install folder>\library.csv (read-only on the share).
# Same as "Rescan library" in the panel. Can be run by hand or from Task Scheduler.
# Only one scan runs at a time (a second one exits with an error). The exit code is
# the scanner's: 0 = library.csv updated, anything else = not updated (see the log).
$Root = $PSScriptRoot   # install folder (the folder this script is in)
$Cfg = $null
try { $Cfg = Get-Content -Raw -Path (Join-Path $Root 'config.json') -ErrorAction Stop | ConvertFrom-Json } catch { }
$log = "$Root\logs\scan-library.log"
Add-Content -Path $log -Encoding UTF8 -Value "`r`n=== Rescan from rescan-library.ps1 $(Get-Date -Format s) ==="
& node "$Root\tools\scan-library.js" 2>&1 | ForEach-Object {
    $line = "$_"
    Write-Host $line
    Add-Content -Path $log -Encoding UTF8 -Value $line
}
$code = $LASTEXITCODE
if ($code -ne 0) {
    Write-Host "Library scan failed (exit code $code); library.csv was not updated."
    Add-Content -Path $log -Encoding UTF8 -Value "=== exit code $code ==="
}
exit $code
