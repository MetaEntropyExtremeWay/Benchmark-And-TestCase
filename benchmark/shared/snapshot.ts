/**
 * 链线库快照 / restore / 一致性指纹（formation 冻结底座 → 每臂前复位的三重控制之一）。
 *
 * 形态：pg_dump 自定义格式（-Fc，压缩 + 选择性恢复）→ restore = 停实例（dropdb 会
 * 被活连接顶住，且 Spring 池对 drop/create 不知情——干净起停最稳）→ dropdb →
 * createdb → pg_restore → 起实例（新库 Flyway 无事可做，dump 已带 schema）。
 *
 * 一致性指纹：全部 public 表逐表 count + 全行 md5（row_to_json 文本按序聚合——
 * 顺序确定，不依赖物理存储序；memories 的 meta.activation / last_decay_ms 为
 * 时间衰减活字段，指纹层屏蔽——见 FINGERPRINT_MASKED_COLUMNS）。用途：①快照后
 * 留档（与 manifest 同落）②restore 幂等证明（连续两 restore 指纹全等）③臂间
 * 复位核验（每臂 restore 后指纹应等于快照指纹——防「restore 静默半途」的脏底座）。
 *
 * 用法（benchmark 根）：
 *   npx tsx shared/snapshot.ts --dataset=lme --snap                    # 快照 → 缺省位（output/<ds>/chain/snapshots/<时间戳>.dump）
 *   npx tsx shared/snapshot.ts --dataset=lme --snap --out=<file>       # 快照 → 指定文件
 *   npx tsx shared/snapshot.ts --dataset=lme --restore=<file>          # 停实例→重建→restore→起实例→指纹对账
 *   npx tsx shared/snapshot.ts --dataset=lme --idempotency             # 验证面：快照→restore→指纹→再 restore→指纹，两指全等才绿
 *   npx tsx shared/snapshot.ts --dataset=lme --fingerprint             # 只算当前库指纹（对账用）
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from './args.ts';
import { benchRoot, loadChainEnv, pgBinDir, PG_CONN } from './config.ts';

/** 指纹形状：{表: {rows, md5}}——全表全行，确定性排序。 */
export type Fingerprint = Record<string, { rows: number; md5: string }>;

/** 指纹层屏蔽的「活字段」（表 → jsonb 路径）：产品侧随墙钟单调前移、与库内容无关的
 *  字段。实测 memories.meta.activation / last_decay_ms——衰减调度周期改写全部带向量
 *  行；不屏蔽则跨小时/过夜的每臂 restore 对账门必炸（dump 冻结在快照时刻，restore
 *  后启动即补算到当前时刻）。屏蔽只发生在指纹取数，不改库、不改产品行为。 */
const FINGERPRINT_MASKED_COLUMNS: Record<string, string[][]> = {
  memories: [['meta', 'activation'], ['meta', 'last_decay_ms']],
};

function pg(tool: string, args: string[], timeoutMs = 300_000): string {
  const exe = path.join(pgBinDir(), `${tool}.exe`);
  const r = spawnSync(exe, ['-h', PG_CONN.host, '-p', String(PG_CONN.port), '-U', PG_CONN.user, ...args], {
    encoding: 'utf8',
    timeout: timeoutMs,
  });
  if (r.status !== 0) {
    throw new Error(`${tool} 失败（exit ${r.status}）：${String(r.stderr ?? r.stdout ?? '').slice(0, 500)}`);
  }
  return r.stdout ?? '';
}

/** 指纹算法版本（sidecar 落盘/对账口径）：2 = 分桶聚合（每 1k 行桶内 md5 → 桶 md5
 *  串再 md5）。1 = 单串全表聚合——全表 row_to_json 文本和 >1GB 量级撞 PG
 *  字符串缓冲上限 OOM，2 起分桶；两版 md5 值不可比，跨版 sidecar 对账跳过（restore
 *  面版本不等时打警告跳过，不当脏库拦）。 */
export const FINGERPRINT_ALGORITHM = 2;

/** 当前库全表指纹（动态表清单——schema 演化免维护；逐表一查询）。 */
export function fingerprint(dbName: string): Fingerprint {
  const tables = pg('psql', ['-d', dbName, '-tAc',
    "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename"], 60_000)
    .split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const out: Fingerprint = {};
  for (const t of tables) {
    // 全行 md5：row_to_json 文本自身排序（确定性，与物理序无关）；分桶 1k 行——桶内
    // string_agg 远离 1GB 上限，桶 md5 有序拼接后再 md5（等价全表确定性聚合）；空表
    // 标量子查询返 NULL → coalesce 到 md5('')（d41d8…，保持 32 位 hex 形状可正则）。
    // memories 特例——meta.activation / meta.last_decay_ms 是产品侧时间衰减字段，实例
    // 一运行就单调前移（restore 后启动还会把衰减补算到当前墙钟），全行 md5 对快照永远
    // 追不平；指纹层 jsonb #- 屏蔽这两个字段，其余内容（含 meta 其余键）逐字节参与。
    const mask = FINGERPRINT_MASKED_COLUMNS[t];
    const xExpr = mask
      ? `(${mask.reduce((e, p) => `${e} #- ARRAY[${p.map(k => `'${k}'`).join(',')}]::text[]`, 'row_to_json(t)::jsonb')})::text`
      : 'row_to_json(t)::text';
    const row = pg('psql', ['-d', dbName, '-tAc',
      `WITH s AS (SELECT ${xExpr} AS x FROM ${t} t), ` +
      `b AS (SELECT (row_number() OVER (ORDER BY x) - 1) / 1000 AS k, x FROM s), ` +
      `m AS (SELECT k, md5(string_agg(x, E'\\n' ORDER BY x)) AS h FROM b GROUP BY k) ` +
      `SELECT (SELECT count(*) FROM s), coalesce((SELECT md5(string_agg(h, '' ORDER BY k)) FROM m), md5(''))`], 300_000)
      .trim();
    const m = /^(\d+)\|([0-9a-f]{32})$/.exec(row);
    if (!m) throw new Error(`指纹查询形状意外（${t}）：${row.slice(0, 120)}`);
    out[t] = { rows: Number(m[1]), md5: m[2] };
  }
  return out;
}

export function fingerprintEquals(a: Fingerprint, b: Fingerprint): boolean {
  const ka = Object.keys(a).sort().join(',');
  const kb = Object.keys(b).sort().join(',');
  if (ka !== kb) return false;
  return Object.keys(a).every(t => a[t].rows === b[t].rows && a[t].md5 === b[t].md5);
}

export function snapshot(dbName: string, outFile: string): void {
  mkdirSync(path.dirname(outFile), { recursive: true });
  pg('pg_dump', ['-d', dbName, '-Fc', '-f', outFile]);
  if (!existsSync(outFile)) throw new Error(`pg_dump 报成功但文件不在：${outFile}`);
}

function benchApp(action: string, dataset: 'lme' | 'locomo'): void {
  const ps1 = path.join(benchRoot, 'shared', 'scripts', 'mem-bench-app.ps1');
  const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1, action, '-Dataset', dataset, '-Line', 'lmg'], {
    encoding: 'utf8',
    timeout: 180_000,
  });
  const text = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  if (r.status !== 0 || /FAIL|REFUSED/.test(text)) {
    throw new Error(`mem-bench-app ${action} 失败：${text.slice(-500)}`);
  }
}

/** restore 全链：停链线实例 → dropdb → createdb → pg_restore → 起实例 → 指纹对账
 *  （对账基线 = dump 后即时指纹——restore 与快照同源必等；调用方传 null 跳过对账）。
 *  返回 restore 后指纹。 */
export function restore(dbName: string, dumpFile: string, dataset: 'lme' | 'locomo', expect: Fingerprint | null): Fingerprint {
  if (!existsSync(dumpFile)) throw new Error(`dump 文件不在：${dumpFile}`);
  benchApp('stop', dataset);
  try {
    // 清场：断掉占库会话再 drop——spawnSync 超时在 Windows 杀不净子进程，前次
    // restore 的 pg_restore 可能还挂着（实测：僵尸 pg_restore 顶住 dropdb 二十分钟）；
    // best-effort（权限不足不阻断，dropdb --force 自会再兜一层）。
    try {
      pg('psql', ['-d', 'postgres', '-c',
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${dbName}' AND pid <> pg_backend_pid()`]);
    } catch { /* 清场失败交 dropdb --force */ }
    pg('dropdb', ['--if-exists', '--force', dbName]);
    pg('createdb', [dbName]);
    // 大底座恢复（400k+ 行 + 索引重建）实测超 5min 缺省窗——放宽到 30min
    pg('pg_restore', ['-d', dbName, '--no-owner', '--no-privileges', dumpFile], 1_800_000);
  } finally {
    benchApp('start', dataset); // 无论 restore 成败都把实例拉回（停着的实例比坏库更难排查）
  }
  const fp = fingerprint(dbName);
  if (expect && !fingerprintEquals(fp, expect)) {
    throw new Error('restore 指纹对账失败：restore 后库内容 ≠ 快照指纹（表清单/行数/全行 md5 有差）——不得在此库上跑臂');
  }
  return fp;
}

// ------------------------------------------------------------------ CLI

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const dataset = args.dataset === 'locomo' ? 'locomo' as const : 'lme' as const;
  const cfg = loadChainEnv(dataset);
  const log = (m: string) => console.log(`[chain-snap] ${m}`);

  if (args.snap) {
    const outFile = args.out ?? path.join(cfg.stateDir, 'chain', 'snapshots', `form-${new Date().toISOString().replace(/[:T]/g, '-').slice(0, 17)}.dump`);
    log(`快照 ${cfg.dbName} → ${outFile}`);
    snapshot(cfg.dbName, outFile);
    const fp = fingerprint(cfg.dbName);
    writeFileSync(outFile.replace(/\.dump$/, '.fingerprint.json'), JSON.stringify({ dbName: cfg.dbName, at: new Date().toISOString(), algorithm: FINGERPRINT_ALGORITHM, fingerprint: fp }, null, 1), 'utf8');
    const rows = Object.values(fp).reduce((a, t) => a + t.rows, 0);
    log(`完成：${Object.keys(fp).length} 表 / ${rows} 行，指纹落 ${path.basename(outFile)}.fingerprint.json`);
    return;
  }

  if (args.restore) {
    // sidecar 名与 snap 落盘同式（剥 .dump 后缀再接 .fingerprint.json）——曾按全名
    // 直拼找 `*.dump.fingerprint.json`，snap 从不落这个名，导致对账被静默跳过
    const sidecar = `${args.restore.replace(/\.dump$/, '')}.fingerprint.json`;
    let expect: Fingerprint | null = null;
    if (existsSync(sidecar)) {
      const sc = JSON.parse(readFileSync(sidecar, 'utf8')) as { algorithm?: number; fingerprint?: Fingerprint };
      if (sc.algorithm !== FINGERPRINT_ALGORITHM) {
        log(`警告：sidecar 指纹算法版本 ${sc.algorithm ?? '(无戳=1)'} ≠ 当前 ${FINGERPRINT_ALGORITHM}（md5 值跨版不可比）——跳过对账`);
      } else {
        expect = sc.fingerprint ?? null;
      }
    }
    log(`restore ${cfg.dbName} ← ${args.restore}${expect ? '（带指纹对账）' : '（跳过对账）'}`);
    const fp = restore(cfg.dbName, args.restore, dataset, expect);
    log(`完成：${Object.keys(fp).length} 表 / ${Object.values(fp).reduce((a, t) => a + t.rows, 0)} 行`);
    return;
  }

  if (args.idempotency) {
    // 一致性闸验证面：快照 → restore(1) → 指纹 → restore(2) → 指纹；两指全等才绿
    const dump = path.join(cfg.stateDir, 'chain', 'snapshots', `idempotency-probe.dump`);
    log(`幂等验证：快照 → 两次 restore 全程指纹对账`);
    snapshot(cfg.dbName, dump);
    const base = fingerprint(cfg.dbName);
    const r1 = restore(cfg.dbName, dump, dataset, base);
    log(`restore#1 指纹对快照：${fingerprintEquals(r1, base) ? '一致' : '不一致（异常——restore 半途）'}`);
    const r2 = restore(cfg.dbName, dump, dataset, r1);
    const ok = fingerprintEquals(r1, r2);
    log(`restore#2 指纹对 restore#1：${ok ? '一致 ✓ 幂等验证通过' : '不一致 ✗'}`);
    process.exit(ok ? 0 : 4);
  }

  if (args.fingerprint) {
    const fp = fingerprint(cfg.dbName);
    console.log(JSON.stringify(fp, null, 1));
    return;
  }

  throw new Error('缺动作：--snap / --restore=<file> / --idempotency / --fingerprint（见文件头用法）');
}

if (!process.env.VITEST) {
  main().catch(err => {
    console.error(String((err as Error).stack ?? err));
    process.exit(1);
  });
}
