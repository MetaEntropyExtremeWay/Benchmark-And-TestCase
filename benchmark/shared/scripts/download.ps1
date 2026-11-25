# Download benchmark datasets into bench/data/ (gitignored - never commit, never ship).
# LongMemEval-cleaned (MIT) via hf-mirror; swap the host to huggingface.co if the
# mirror is unreachable in your network.
# Usage: powershell -File shared/scripts/download.ps1

$ErrorActionPreference = 'Stop'
$dataDir = Join-Path $PSScriptRoot '..\data'
New-Item -ItemType Directory -Force $dataDir | Out-Null

# Only the S file feeds the lme-126 pack (extract.ts). The other two are optional
# extras kept for convenience (oracle haystacks / LoCoMo) - comment them out to save bandwidth.
$files = @(
    @{ Url = 'https://hf-mirror.com/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json'; Out = 'longmemeval_s_cleaned.json' }
)

foreach ($f in $files) {
    $dest = Join-Path $dataDir $f.Out
    if (Test-Path $dest) {
        Write-Output "SKIP (exists): $f.Out"
        continue
    }
    Write-Output "GET $($f.Url)"
    Invoke-WebRequest -Uri $f.Url -OutFile $dest
    $mb = [math]::Round((Get-Item $dest).Length / 1MB, 1)
    Write-Output "  -> $f.Out (${mb} MB)"
}

Write-Output 'done. LongMemEval is MIT; the downloaded file stays in this gitignored dir, never enters any repo.'
