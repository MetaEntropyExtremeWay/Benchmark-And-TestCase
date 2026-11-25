# Dedicated mc (memory service) bench instance: port 8081 + own database.
# ============================================================
# Why isolation: context chain closure walks parents up to /root, so a bench
# context inherits whatever lives in the dev instance's /root pool - any pool
# content outside the bench corpus would leak into retrieval/prefill reads and
# skew the benchmark. A dedicated instance starts with an EMPTY /root by
# construction and cannot be re-polluted by day-to-day dev usage. The dev
# instance (port 8080, started by the mc repo's scripts\services.ps1) is
# untouched; both share the same PG on 5433 and the same embed API key.
#
# Usage:  .\shared\scripts\mem-bench-app.ps1 <start|stop|reset|status> [-Dataset lme|locomo] [-Line mc|lmg]
#   start  - creates the per-dataset DB if missing (Flyway migrates on boot),
#            starts newest lmg-mem-*.jar with port/db overrides
#   stop   - kills the listener (refuses non-lmg-mem squatters)
#   reset  - stop -> dropdb --if-exists -> createdb -> start (empty DB, Flyway re-migrates)
#   status - listener pid + health + db row count
#   start does NOT clear an existing database (only creates if missing); use
#   reset for a guaranteed-empty rerun.
#
# Per-line/per-dataset coordinates (bench products live in benchmark/output/<dataset>/):
#     mc  line: lme -> port 8081, db lmg_mem_bench_lme      | locomo -> 8082, lmg_mem_bench_locomo
#     lmg line: lme -> port 8084, db lmg_mem_bench_lme_chain | locomo -> 8085, lmg_mem_bench_locomo_chain
# (do NOT pin one dataset's URL in benchmark/.env - config.ts hard-errors on cross-
#  dataset canonical ports, and with no env pin at all the harness defaults to
#  the dataset's own canonical coordinate.)
#
# ASCII-only per scripts/ convention (PS 5.1 reads BOM-less UTF-8 as ANSI).

param(
  [string]$Action = "",
  [string]$Dataset = "lme",
  [string]$Line = "mc",       # "mc" = direct-retrieval line (8081/8082); "lmg" = product-chain line (8084/8085)
  [string]$AmbientTopk = ""    # optional server ambient-topk override:
                               # pass "0" for the switched-off instance; empty = server default
)

$ErrorActionPreference = "Stop"
$benchRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)   # benchmark/ (script lives in shared/scripts/)
# mc repo root (jar + dev PG): explicit BENCH_MC_ROOT wins; default = sibling of the
# public repo's parent (workspace root). Fail loud if absent.
if ($env:BENCH_MC_ROOT) {
  $memRoot = $env:BENCH_MC_ROOT
} else {
  $memRoot = Join-Path $benchRoot "..\..\lmg-mem"
}
if (-not (Test-Path $memRoot)) {
  Write-Host "bench app: FAIL - mc repo root not found at '$memRoot' (clone lmg-mem there or set BENCH_MC_ROOT)"
  exit 1
}
$pgbin     = Join-Path $memRoot "dev\pg\pgsql\bin"      # EDB zip layout
if (-not (Test-Path $pgbin)) { $pgbin = Join-Path $memRoot "dev\pg\bin" }  # fallback: flattened
$pgdata    = Join-Path $memRoot "dev\pgdata"
$key = "${Dataset}-${Line}"
$portByKey = @{ "lme-mc" = 8081; "locomo-mc" = 8082; "lme-lmg" = 8084; "locomo-lmg" = 8085 }
$dbByKey     = @{ "lme-mc" = "lmg_mem_bench_lme"; "locomo-mc" = "lmg_mem_bench_locomo";
                    "lme-lmg" = "lmg_mem_bench_lme_chain"; "locomo-lmg" = "lmg_mem_bench_locomo_chain" }
if (-not $portByKey.ContainsKey($key)) {
  Write-Host "unknown dataset/line '$key' (expected: -Dataset lme|locomo -Line mc|lmg)"
  exit 1
}
# The lmg product-chain line pins the verbatim read window server-side: scope=auto is the
# product default (session anchor -> own project subtree, cross-session); scope lock
# removes the request-level param so no stray bench caller can pick a different window;
# GC off because bench snapshots re-insert rows with old created_at - the 30d TTL sweep
# (first pass 60s after boot) would hard-delete revived rows.
$isChain = $Line -eq "lmg"
$port   = $portByKey[$key]
$dbName = $dbByKey[$key]

function Get-Listener {
  $c = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $c) { return $null }
  return (Get-CimInstance Win32_Process -Filter "ProcessId=$($c.OwningProcess)")
}

function Stop-BenchApp {
  $p = Get-Listener
  if (-not $p) { Write-Host "bench app stop: nothing listening on $port"; return $true }
  if ($p.CommandLine -notmatch 'lmg-mem') {
    Write-Host "bench app stop: REFUSED - port $port held by a non-lmg-mem process (pid $($p.ProcessId)):"
    Write-Host "      $($p.CommandLine)"
    return $false
  }
  Stop-Process -Id $p.ProcessId -Force
  foreach ($i in 1..20) {
    if (-not (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)) { break }
    Start-Sleep -Milliseconds 300
  }
  Write-Host "bench app stop: killed lmg-mem pid $($p.ProcessId)"
  return $true
}

function Reset-BenchApp {
  if (-not (Stop-BenchApp)) { return $false }
  & ((Join-Path $pgbin "dropdb.exe")) @("-h", "127.0.0.1", "-p", "5433", "-U", "lmg", "--if-exists", $dbName)
  if ($LASTEXITCODE -ne 0) { Write-Host "bench app reset: FAIL - dropdb $dbName"; return $false }
  Write-Host "bench app reset: dropped $dbName (recreating empty)"
  return (Start-BenchApp)
}

function Start-BenchApp {
  # multi-module layout: prefer the app-module target (the repo-root target may hold
  # stale single-module-era jars)
  $jar = Get-ChildItem (Join-Path $memRoot "lmg-mem-app\target") -Filter "lmg-mem-*.jar" -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -notmatch '\.original$' } | Sort-Object LastWriteTime | Select-Object -Last 1
  if (-not $jar) {
    $jar = Get-ChildItem (Join-Path $memRoot "target") -Filter "lmg-mem-*.jar" |
      Sort-Object LastWriteTime | Select-Object -Last 1
  }
  if (-not $jar) { Write-Host "bench app start: FAIL - no jar in lmg-mem\lmg-mem-app\target (run: mvn package)"; return $false }
  if (-not (Stop-BenchApp)) { return $false }

  # dev PG must be up (db init needs it; app needs it)
  $pgok = & ((Join-Path $pgbin "pg_ctl.exe")) @("-D", (Join-Path $memRoot "dev\pgdata"), "status")
  if ($LASTEXITCODE -ne 0) { Write-Host "bench app start: FAIL - dev PG (5433) not running; start it: lmg-mem\scripts\services.ps1 db start"; return $false }

  $exists = & ((Join-Path $pgbin "psql.exe")) @("-h", "127.0.0.1", "-p", "5433", "-U", "lmg", "-d", "postgres", "-tAc", "SELECT 1 FROM pg_database WHERE datname='$dbName'")
  if ("$exists" -notmatch "1") {
    & ((Join-Path $pgbin "createdb.exe")) @("-h", "127.0.0.1", "-p", "5433", "-U", "lmg", $dbName)
    if ($LASTEXITCODE -ne 0) { Write-Host "bench app start: FAIL - createdb $dbName"; return $false }
    Write-Host "bench app start: created database $dbName (Flyway will migrate on boot)"
  }

  . (Join-Path $memRoot "scripts\env.ps1")       # embed API key etc. (never printed)
  $env:LMG_MEM_EMBED_PROVIDER = "openai"          # bench always needs real embeddings
  $env:LMG_MEM_PORT = "$port"
  $env:LMG_MEM_DB_URL = "jdbc:postgresql://127.0.0.1:5433/$dbName"
  $env:LMG_MEM_LOG_FILE = Join-Path $memRoot ("logs\mc-bench-" + $key + ".log")   # per instance, separate from dev
  $env:LMG_MEM_WORKER_CONCURRENCY = "8"           # in-batch embed parallelism (needs lmg-mem >= 0.9.27; below Hikari pool 10)
  $env:LMG_MEM_WORKER_BATCH = "96"                # bigger batch amortizes the 1s fixedDelay tick; ~22 ops/s vs ~15 at 32
  if ($isChain) {
    $env:LMG_MEM_VERBATIM_SCOPE = "auto"          # v2 read window: session anchor -> project subtree (explicit; also the default)
    $env:LMG_MEM_VERBATIM_SCOPE_LOCK = "true"     # server-side single adjudication; product clients never pass scope
    $env:LMG_MEM_VERBATIM_GC_ENABLED = "false"    # snapshot revives rows with old created_at; 30d TTL sweep would eat them
    if ($AmbientTopk -ne "") { $env:LMG_MEM_SEARCH_AMBIENT_TOPK = $AmbientTopk }  # optional server ambient-topk override: "0" = ambient zone off
  }

  $p = Start-Process -FilePath (Join-Path $env:JAVA_HOME "bin\java.exe") -ArgumentList "-jar", $jar.FullName `
    -WorkingDirectory $memRoot -PassThru -WindowStyle Hidden

  $up = $false
  foreach ($i in 1..60) {
    try {
      $h = Invoke-RestMethod "http://127.0.0.1:$port/actuator/health" -TimeoutSec 2
      if ($h.status -eq 'UP') { $up = $true; break }
    } catch {}
    if ($p.HasExited) { Write-Host "bench app start: FAIL - process exited early, see lmg-mem\logs\mc-bench.log"; return $false }
    Start-Sleep -Milliseconds 800
  }
  if (-not $up) { Write-Host "bench app start: FAIL - not healthy after 48s, see lmg-mem\logs\mc-bench.log"; return $false }
  Write-Host "bench app start: OK  pid=$($p.Id)  port=$port  db=$dbName  jar=$($jar.Name)  log=logs\mc-bench.log"
  return $true
}

function Show-BenchAppStatus {
  $p = Get-Listener
  if (-not $p) { Write-Host "bench app status: nothing listening on $port"; return }
  Write-Host "bench app status: pid=$($p.ProcessId)"
  try {
    $h = Invoke-RestMethod "http://127.0.0.1:$port/actuator/health" -TimeoutSec 2
    Write-Host "        health=$($h.status)"
  } catch { Write-Host "        health=UNREACHABLE" }
  try {
    $n = & ((Join-Path $pgbin "psql.exe")) @("-h", "127.0.0.1", "-p", "5433", "-U", "lmg", "-d", $dbName, "-tAc", "SELECT count(*) FROM memories")
    Write-Host "        db $dbName rows: $n"
  } catch { Write-Host "        db rows: (query failed)" }
}

switch ("$Action") {
  "start"  { if (-not (Start-BenchApp)) { exit 1 } }
  "stop"   { if (-not (Stop-BenchApp)) { exit 1 } }
  "reset"  { if (-not (Reset-BenchApp)) { exit 1 } }
  "status" { Show-BenchAppStatus }
  default {
    Write-Host "usage: .\shared\scripts\mem-bench-app.ps1 <start|stop|reset|status> [-Dataset lme|locomo] [-Line mc|lmg]   (lme-mc=:8081, lme-lmg=:8084/lmg_mem_bench_lme_chain)"
    exit 1
  }
}

exit 0
