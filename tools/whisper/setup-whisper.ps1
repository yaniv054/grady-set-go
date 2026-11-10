# Grady Set Go - Playout App. Created by Yaniv Grady. Copyright (c) 2026 Yaniv Grady.
# One-time setup for timed text: downloads whisper.cpp (Windows x64, CPU) and a speech model
# into this folder. Nothing is installed in Windows; deleting the folder removes it.
#   powershell -ExecutionPolicy Bypass -File <install folder>\tools\whisper\setup-whisper.ps1 [-Language multi|he]
#
# -Language multi (default): the multilingual OpenAI large-v3-turbo model in ggml format
#   (ggerganov/whisper.cpp on Hugging Face), about 1.6 GB. config.json: "whisper_model": "ggml-large-v3-turbo.bin",
#   "whisper_language": "auto" (or a code such as "en").
# -Language he: the Hebrew model ivrit-ai/whisper-large-v3-turbo-ggml (Apache-2.0), about 1.62 GB.
#   config.json: "whisper_model": "ivrit-large-v3-turbo.bin", "whisper_language": "he".
# Model licences are the model authors', not this project's; check them before commercial use.
param([ValidateSet('multi', 'he')][string]$Language = 'multi')

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest is very slow with the progress bar
$root = $PSScriptRoot
$bin = Join-Path $root 'bin'
$models = Join-Path $root 'models'
if ($Language -eq 'he') {
    $modelName = 'ivrit-large-v3-turbo.bin'
    $modelUrl = 'https://huggingface.co/ivrit-ai/whisper-large-v3-turbo-ggml/resolve/main/ggml-model.bin'
} else {
    $modelName = 'ggml-large-v3-turbo.bin'
    $modelUrl = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin'
}
$model = Join-Path $models $modelName
New-Item -ItemType Directory -Force -Path $bin, $models | Out-Null

# 1. whisper.cpp: latest official release, CPU build.
$cli = Get-ChildItem -Path $bin -Recurse -Filter 'whisper-cli.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
if ($cli) {
    Write-Host "whisper.cpp already present: $($cli.FullName)"
} else {
    # Not every release carries Windows binaries: take the newest one that does.
    Write-Host 'Looking up whisper.cpp releases on GitHub...'
    $rels = Invoke-RestMethod -Uri 'https://api.github.com/repos/ggml-org/whisper.cpp/releases?per_page=30' -Headers @{ 'User-Agent' = 'GradySetGo-Playout-setup' }
    $rel = $null; $asset = $null
    foreach ($r in $rels) {
        if ($r.draft -or $r.prerelease) { continue }
        $a = $r.assets | Where-Object { $_.name -eq 'whisper-bin-x64.zip' } | Select-Object -First 1
        if ($a) { $rel = $r; $asset = $a; break }
    }
    if (-not $asset) {
        Write-Host 'No recent release has whisper-bin-x64.zip. Windows files in the newest releases:'
        $rels | Select-Object -First 5 | ForEach-Object {
            $names = ($_.assets | ForEach-Object { $_.name }) -join ', '
            Write-Host "  $($_.tag_name): $(if ($names) { $names } else { '(no files)' })"
        }
        Write-Host 'Send this list to Claude. Nothing was installed.'
        exit 1
    }
    if ($rel.tag_name -ne $rels[0].tag_name) { Write-Host "The newest release ($($rels[0].tag_name)) has no Windows build; using $($rel.tag_name)." }
    Write-Host "Downloading $($asset.name) from release $($rel.tag_name)..."
    $zip = Join-Path $root $asset.name
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zip -UseBasicParsing
    Expand-Archive -Path $zip -DestinationPath $bin -Force
    Remove-Item -LiteralPath $zip
    $cli = Get-ChildItem -Path $bin -Recurse -Filter 'whisper-cli.exe' | Select-Object -First 1
    if (-not $cli) { Write-Host 'The download has no whisper-cli.exe. Send the contents of tools\whisper\bin to Claude.'; exit 1 }
    Set-Content -Path (Join-Path $root 'version.txt') -Value "whisper.cpp $($rel.tag_name)"
    Write-Host "whisper.cpp $($rel.tag_name) ready: $($cli.FullName)"
}

# 2. The speech model.
if ((Test-Path -LiteralPath $model) -and ((Get-Item -LiteralPath $model).Length -gt 1GB)) {
    Write-Host "Model already present: $model"
} else {
    Write-Host "Downloading the model $modelName (about 1.6 GB), this takes a while..."
    $part = "$model.part"
    Invoke-WebRequest -Uri $modelUrl -OutFile $part -UseBasicParsing
    if ((Get-Item -LiteralPath $part).Length -lt 1GB) { Write-Host 'The model download is incomplete. Run this script again.'; exit 1 }
    Move-Item -LiteralPath $part -Destination $model -Force
    Write-Host "Model ready: $model"
}

# 3. Check the program runs and has the options the test uses.
# whisper-cli writes to stderr; with 'Stop' PowerShell 5.1 would treat that as an error.
$ErrorActionPreference = 'Continue'
$help = & $cli.FullName --help 2>&1 | ForEach-Object { "$_" } | Out-String
foreach ($o in '-ojf', '-osrt', '-of', '-l ', '-t ') {
    if ($help -notmatch [regex]::Escape($o)) { Write-Host "whisper-cli has no '$o' option. Send this output to Claude:"; Write-Host $help; exit 1 }
}

$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
Write-Host ''
Write-Host "Ready. CPU: $($cpu.Name.Trim()), $($cpu.NumberOfCores) cores / $($cpu.NumberOfLogicalProcessors) threads."
Write-Host "Next: set whisper_model to '$modelName' in config.json (and whisper_language), then tick Timed text in Overnight analysis."
