# Grady Set Go - Playout App. Created by Yaniv Grady. Copyright (c) 2026 Yaniv Grady.
# Start the Grady Set Go panel. Open http://127.0.0.1:8790
# It proxies ffplayout on 127.0.0.1:8787 (start that first with start-ffplayout.ps1).
# The panel appends method + path + status to logs\panel.log (never bodies, queries or
# keys); panel.out.log holds the console output of the current run only.
# The previous run's console output is kept (panel.out.log.1 ... .5) before Start-Process
# truncates the files; panel.log (requests and PANEL start/crash lines) is appended, not touched.
$Root = $PSScriptRoot   # install folder (the folder this script is in)
$Cfg = $null
try { $Cfg = Get-Content -Raw -Path (Join-Path $Root 'config.json') -ErrorAction Stop | ConvertFrom-Json } catch { }
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
Rotate-Log "$Root\logs\panel.out.log"
Rotate-Log "$Root\logs\panel.err.log"

Start-Process node -ArgumentList "`"$Root\panel\server.js`"" `
    -WorkingDirectory "$Root\panel" `
    -RedirectStandardOutput "$Root\logs\panel.out.log" `
    -RedirectStandardError "$Root\logs\panel.err.log" `
    -WindowStyle Hidden
