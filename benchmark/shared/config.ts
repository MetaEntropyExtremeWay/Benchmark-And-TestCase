/**
 * bench 配置（BENCH_MC_* / BENCH_LMG_* / BENCH_* 三组键，环境变量优先于 benchmark/.env）。
 * mc 检索直测线读 BENCH_MC_*（prepare / recall / clean）；lmg 产品链读 BENCH_LMG_*；
 * judge / 抽取等组件面读 BENCH_*。产品仓根（mc / lmg）经 BENCH_MC_ROOT / BENCH_LMG_ROOT
 * 解析，缺省按「公开仓的上级工作区里的兄弟仓」自动探测。
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const benchRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadEnvFile(): Record<string, string> {
  const out: Record<string, string> = {};
  let text: string;
  try {
    text = readFileSync(path.join(benchRoot, '.env'), 'utf8');
  } catch {
    return out;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

const fileEnv = loadEnvFile();

function get(name: string, fallback: string): string {
  const v = process.env[name] ?? fileEnv[name];
  return v && v.length > 0 ? v : fallback;
}

function getInt(name: string, fallback: number): number {
  const v = Number(get(name, String(fallback)));
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

/** mc 直测线分数据集 bench 实例规范坐标（跨域硬门判据 + 免配置缺省，
 *  与 mem-bench-app.ps1 的端口表同源）。 */
export const CANONICAL_MC_MEM_URL: Record<'lme' | 'locomo', string> = {
  lme: 'http://127.0.0.1:8081',
  locomo: 'http://127.0.0.1:8082',
};

export type BenchDataset = keyof typeof CANONICAL_MC_MEM_URL;

/** lmg 链线分数据集 bench 实例规范坐标（8084/8085），与 mc 线两实例互不混用。 */
export const CANONICAL_LMG_MEM_URL: Record<'lme' | 'locomo', string> = {
  lme: 'http://127.0.0.1:8084',
  locomo: 'http://127.0.0.1:8085',
};

/** lmg 链线库名（与 mem-bench-app.ps1 / 快照脚本同源；_chain 后缀 = 链线专用库判据）。 */
export const CHAIN_DB_NAME: Record<'lme' | 'locomo', string> = {
  lme: 'lmg_mem_bench_lme_chain',
  locomo: 'lmg_mem_bench_locomo_chain',
};

/** dev PG 坐标（快照 / restore 直连用；与 mem-bench-app.ps1 同源——连接参数在那边有
 *  落地注释）。pgbin 解析：EDB zip 形态优先、扁平形态回落（与 ps1 同序）。 */
export function pgBinDir(): string {
  const memRoot = mcRoot();
  const zipped = path.join(memRoot, 'dev', 'pg', 'pgsql', 'bin');
  if (existsSync(zipped)) return zipped;
  return path.join(memRoot, 'dev', 'pg', 'bin');
}
export const PG_CONN = { host: '127.0.0.1', port: 5433, user: 'lmg' } as const;

function portOf(url: string): string {
  try {
    return new URL(url).port;
  } catch {
    return '';
  }
}

/**
 * memUrl 跨域硬门：URL 指到「别的数据集的规范端口」即抛错——.env 钉死单域坐标时直跑
 * 另一数据集，会把数据静默灌进别家库。自定义实例坐标（不撞任一规范端口）放行：
 * 真起自定义实例的人知道自己在干什么。
 */
export function assertMemUrl(dataset: BenchDataset, url: string): void {
  const port = portOf(url);
  // 跨域全家门：mc 两域互斥 + 也不许指进链线实例（链线库只收链线 formation 写入）
  const foreign: Record<string, string> = {
    ...Object.fromEntries(Object.entries(CANONICAL_MC_MEM_URL).filter(([k]) => k !== dataset)),
    ...Object.fromEntries(
      Object.entries(CANONICAL_LMG_MEM_URL).map(([k, v]) => [`lmg:${k}`, v] as const),
    ),
  };
  for (const [other, canonical] of Object.entries(foreign)) {
    const otherPort = portOf(canonical);
    if (otherPort !== '' && port === otherPort) {
      throw new Error(
        `BENCH_MC_MEM_URL=${url} 是 ${other} 域 bench 实例的规范坐标——跑 ${dataset} 会把数据灌进别家库。` +
          `修法：清掉 benchmark\\.env 里的 BENCH_MC_MEM_URL（缺省即本域规范坐标）；` +
          `本域实例用 shared\\scripts\\mem-bench-app.ps1 start -Dataset ${dataset} 起（${CANONICAL_MC_MEM_URL[dataset]}）；确属自定义实例则换非规范端口。`,
      );
    }
  }
}

/** 链线实例坐标解析：BENCH_LMG_MEM_URL 覆盖 > 本域链线规范坐标。跨域硬门同款
 *  （链线驱动不得指 mc 线实例；链线两域互斥；自定义非规范端口放行）。 */
export function lmgMemUrl(dataset: 'lme' | 'locomo'): string {
  const url = get('BENCH_LMG_MEM_URL', CANONICAL_LMG_MEM_URL[dataset]);
  const port = portOf(url);
  const allForeign: Record<string, string> = {
    ...CANONICAL_MC_MEM_URL,
    ...Object.fromEntries(Object.entries(CANONICAL_LMG_MEM_URL).filter(([k]) => k !== dataset)),
  };
  for (const [other, canonical] of Object.entries(allForeign)) {
    const otherPort = portOf(canonical);
    if (otherPort !== '' && port === otherPort) {
      throw new Error(
        `BENCH_LMG_MEM_URL=${url} 是 ${other} 域实例的规范坐标——链线 formation/答题不得写 mc 线库或别家链线库。` +
          `本域链线实例用 shared\\scripts\\mem-bench-app.ps1 start -Dataset ${dataset} -Line lmg 起（${CANONICAL_LMG_MEM_URL[dataset]}，库 ${CHAIN_DB_NAME[dataset]}）；确属自定义实例则换非规范端口。`,
      );
    }
  }
  return url;
}

/** 产品仓根解析：显式环境变量 > 兄弟目录自动探测（公开仓的上级工作区里的克隆）。
 *  探测不到 = 显式报错带修法，不猜路径。 */
function productRoot(envName: string, dirname: string): string {
  const configured = get(envName, '');
  if (configured) return configured;
  const candidate = path.join(benchRoot, '..', '..', dirname);
  if (existsSync(candidate)) return candidate;
  throw new Error(`${dirname} 仓根未找到（${candidate}）——设 ${envName} 指向该仓的本地克隆`);
}

/** mc 记忆服务仓根（lmg-mem）。 */
export function mcRoot(): string {
  return productRoot('BENCH_MC_ROOT', 'lmg-mem');
}

/** lmg 编排全家仓根（daemon / kernel / exo 各 packages 的仓）。 */
export function lmgRoot(): string {
  return productRoot('BENCH_LMG_ROOT', 'lmg-exo');
}

export interface HarnessEnv {
  /** 数据集 token：源数据选择与产物根共用 */
  dataset: BenchDataset;
  dataDir: string;
  stateDir: string;
  /** mc 服务坐标（prepare 灌库 / 串台验收 / recall 直测用） */
  memUrl: string;
  /** outbox 排空预算（向量化异步灌库后等排空；千级 ops ≈ 数分钟量级） */
  drainMs: number;
}

export function loadHarnessEnv(dataset: BenchDataset = 'lme'): HarnessEnv {
  return {
    dataset,
    dataDir: path.join(benchRoot, 'data'),
    // 产物根按数据集分域：output/<dataset>/<runId>/——清场只动本数据集域内，别家数据不混
    stateDir: path.join(benchRoot, 'output', dataset),
    // 缺省 = 本域规范坐标；跨域（撞别家规范端口）在 assertMemUrl 硬门拦下
    memUrl: (() => {
      const url = get('BENCH_MC_MEM_URL', CANONICAL_MC_MEM_URL[dataset]);
      assertMemUrl(dataset, url);
      return url;
    })(),
    drainMs: getInt('BENCH_MC_DRAIN_MS', 1_800_000),
  };
}

/** lmg 产品链配置：formation / 答题 / 快照驱动共用。BENCH_LMG_* 前缀与 BENCH_MC_*
 *  分立（同 .env 文件两套键互不干扰；跨域门在 lmgMemUrl 内）。 */
export interface ChainEnv {
  dataset: 'lme' | 'locomo';
  memUrl: string;
  dbName: string;
  dataDir: string;
  stateDir: string;
  daemonPort: number;
  /** outbox / verbatim embed 排空预算（formation 收口用；同 drainMs 口径） */
  drainMs: number;
}

export function loadChainEnv(dataset: 'lme' | 'locomo'): ChainEnv {
  return {
    dataset,
    memUrl: lmgMemUrl(dataset),
    dbName: CHAIN_DB_NAME[dataset],
    dataDir: path.join(benchRoot, 'data'),
    stateDir: path.join(benchRoot, 'output', dataset),
    daemonPort: getInt('BENCH_LMG_DAEMON_PORT', 5894),
    drainMs: getInt('BENCH_LMG_DRAIN_MS', 1_800_000),
  };
}

/** 组件线变量（BENCH_，非 BENCH_MC_* / BENCH_LMG_* 前缀）：judge 等读 LLM 坐标。 */
export function benchVar(name: string, fallback: string): string {
  return get(name, fallback);
}

export { benchRoot };
