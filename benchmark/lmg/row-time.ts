/**
 * 行时刻态——qa 开关 --row-time 的机制面：两种态的定义、库补丁的施加 / 还原、
 * 轮次之间的互斥与收尾。
 *
 * 背景：bench formation 缺省不注入源会话时间（--ts=on 才带），原文行时刻全是回放时刻
 * ——考「几天前 / 先后顺序」的题，注入区的行定不了日期；照此读数会把时序桶低分误记成
 * 产品缺陷。两种态：
 *   replay（缺省 = 库的快照态） 原文行时刻 = 回放时刻
 *   source                      原文行时刻 = 源会话日期（当日正午 UTC，与 formation
 *                               --ts=on 的 dateToEpochMs 同值）
 * source 态只改 memories_verbatim 的 ts 列，别的表不动——单变量对照；重灌（--ts=on）
 * 会连带收尾 LLM 的采样差，不可比。服务端 TTL 清扫锚的是 created_at，不受 ts 影响。
 *
 * 生命周期（驱动面 exo/qa.ts 调用）：
 *   轮起 beginRowTime：先取租约，等收尾中的轮退尽，再探在跑的轮——有任何 active 轮即拒跑
 *     （不分同异态：异态重叠两轮读数都污染；同态重叠则互踩同一个 bench daemon）。干净后开局——
 *     source  库不在 source 态 → 施加（增量：只备份还没备份的行）→ 对账；已在 → 只对账
 *     replay  库停在 source 态（上一轮异常退出没还原）→ 自动还原
 *   轮终 end（驱动的 finally）：source 态下自己是最后一个 source 轮 → 还原 → 删备份表；
 *     还有同态轮在跑 → 还原交给最后退出的那个（开局互拒后正常走不到，只护「两轮同时起」的竞态）
 *
 * 并发：qa 驱动起停的是同一个 bench daemon——起时杀旧实例、收尾时整个停掉，同库两轮重叠
 * = 后一轮拆走前一轮的答题面（大量无答）；行时刻态又是库级状态，异态重叠两轮读数都污染。
 * 故开局探到任何在跑的轮即拒跑（曾只对异态拒、同态警告——警告在 quota-run 自动续跑场景
 * 形同虚设，重叠照样发生）。「在跑」靠命名管道租约判活（每轮起一个管道服务端，对端连上
 * 即回一行自报；进程一死句柄即消——无残留文件、无 pid 复用误判）；管道名带库名，不同库
 * 互不可见。卡死轮的解除 = 按 `row-time.ts status` 报的 pid 停掉它，租约随之消失。
 * 判活靠持有者应答，持有者跑库操作期间事件循环必须照转——库访问走异步 spawn，不用
 * spawnSync（同步期间应不了答，会被探成「没在跑」）。
 * 库侧施加 / 还原各在事务级 advisory lock 内，跨进程串行。
 *
 * 收尾与新开局的交接（「上一轮在还原」与「下一轮在施加」不许半路互插）：收尾方先把自己
 * 标成 ending、**租约不撤**去探同态轮——还有在跑的就不管（还原交给最后退出的那个），没有
 * 才还原、还原完才撤租约；开局方探到 ending 的轮就等它消失再往下走。于是还原进行中的
 * 整段时间新轮一定看得到。
 *
 * 与库复位的关系：snapshot --restore 是整库重建（dropdb → pg_restore），备份表随库一起
 * 消失、行时刻回到 replay 态——复位之后不需再还原；复位不得在某轮进行中做（在跑的那轮
 * 后半程会读到另一态，runbook 的臂间序本来就要求轮已结束）。
 *
 * SQL 文本与开局 / 收尾决策都是纯函数或可注入的库面，单测不连库。
 *
 * 子命令（benchmark 根；异常退出后的手工处置面）：
 *   npx tsx lmg/row-time.ts status [--ids=<题集清单>]   库态、备份对账、规划 ↔ 库几何、在跑的 qa 轮
 *   npx tsx lmg/row-time.ts revert                       立即还原到 replay 态（有 source 轮在跑则拒）
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { parseArgs } from '../shared/args.ts';
import { benchRoot, loadChainEnv, pgBinDir, PG_CONN } from '../shared/config.ts';
import { loadPack } from '../shared/pack.ts';
import { sleep } from '../shared/mem.ts';
import { benchProjectId } from '../shared/coords.ts';
import { isProcessEntry } from '../shared/entry.ts';
import { dateToEpochMs, formationSlots } from './formation.ts';
import type { PackQuestion, PackConversation } from '../shared/pack.ts';

export type RowTimeMode = 'replay' | 'source';

/** 原始时刻备份表（库内；在场 = 库停在 source 态，还原时按它回填）。 */
export const BACKUP_TABLE = 'bench_vb_ts_backup';

export function parseRowTimeMode(raw: string | undefined): RowTimeMode {
  if (raw === undefined) return 'replay';
  if (raw === 'replay' || raw === 'source') return raw;
  throw new Error(
    `--row-time 取值无效：${raw}（replay = 回放时刻〔缺省〕/ source = 源会话日期）——等号式单 token：--row-time=source`,
  );
}

// ------------------------------------------------------------------ 规划与闸（纯函数）

/** 一题的行时刻目标：库内会话节点 → 源会话日期时刻（ms）。 */
export interface RowTimeTarget {
  qid: string;
  project: string;
  map: Map<string, number>;
}

/** 规划：逐题 formation 槽位 → 对话节点 → 源对话日期时刻（与灌库同一条几何公式）。 */
export function planRowTime(questions: PackQuestion[], conversations: PackConversation[]): RowTimeTarget[] {
  return questions.map(q => ({
    qid: q.id,
    project: benchProjectId(q.dataset, q.id),
    map: new Map(formationSlots(q, conversations).slots.map(s => [s.context, dateToEpochMs(s.conversation.date ?? '')] as const)),
  }));
}

/** 槽位 ↔ 库几何对账（改时刻前的闸）：库里落在题 project 下的会话节点必须与槽位一一对应
 *  ——有规划外的节点（库不是按这套槽位灌的）或槽位在库里缺席（没灌 / 灌了一半）都拒改：
 *  带着混钟行跑 = 读数不可归因。答题节点（qa-<臂>）不算：它们不落原文行。 */
export function assertRowTimeGeometry(targets: RowTimeTarget[], dbCtx: string[]): void {
  const known = new Set(dbCtx);
  for (const t of targets) {
    const prefix = `${t.project}/`;
    const foreign = dbCtx.filter(c => c.startsWith(prefix) && !t.map.has(c) && !/\/qa-/.test(c));
    if (foreign.length > 0) {
      throw new Error(
        `${t.qid}：库内有 ${foreign.length} 个规划外的会话节点（前 2：${foreign.slice(0, 2).join(' , ')}）——库不是按当前槽位灌的，拒改行时刻`,
      );
    }
    const missing = [...t.map.keys()].filter(c => !known.has(c));
    if (missing.length > 0) {
      throw new Error(`${t.qid}：${missing.length} 个槽位会话库内不存在（前 2：${missing.slice(0, 2).join(' , ')}）——库未灌或灌了一半，拒改行时刻`);
    }
  }
}

/** 续跑一致性闸：产物目录里已有记录的行时刻态须与本轮一致（开关出现之前的旧记录没有
 *  该字段 = replay）。混态 = 同一份 qa-state 里一部分题带源会话时刻、一部分带回放时刻，
 *  读数不可归因——最常见成因是 source 轮被额度窗打断，续跑时忘了带 --row-time=source。 */
export function assertRowTimeConsistent(
  existing: Record<string, { rowTime?: RowTimeMode } | undefined>,
  mode: RowTimeMode,
): void {
  const foreign = Object.entries(existing).filter(([, r]) => (r?.rowTime ?? 'replay') !== mode);
  if (foreign.length === 0) return;
  const other = (foreign[0]![1]?.rowTime ?? 'replay') as RowTimeMode;
  throw new Error(
    `qa-state 里已有 ${foreign.length} 条 ${other} 态的记录（如 ${foreign[0]![0]}）——同一产物目录不许混两种行时刻态；` +
    `续跑请带 --row-time=${other}，要换态就换 --tag 另起目录`,
  );
}

// ------------------------------------------------------------------ SQL（纯函数：文本）

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const ctxArray = (contexts: string[]) => `ARRAY[${contexts.map(lit).join(',')}]::text[]`;
const planValues = (targets: RowTimeTarget[]) =>
  targets.flatMap(t => [...t.map.entries()].map(([ctx, ts]) => `(${lit(ctx)}, ${ts}::bigint)`)).join(',');
const plannedContexts = (targets: RowTimeTarget[]) => targets.flatMap(t => [...t.map.keys()]);
/** 库级 advisory lock 键：按库名 + 备份表名散列（一个 PG 集群里多库并存，锁键不得串库）。 */
const LOCK = `pg_advisory_xact_lock(hashtext(current_database() || ':${BACKUP_TABLE}'))`;

export function sqlBackupTableExists(): string {
  return `SELECT count(*) FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = ${lit(BACKUP_TABLE)};`;
}

/** 备份对账：备份总行数 | 其中当前时刻已不同于备份（= 已改）的行数。 */
export function sqlBackupStats(): string {
  return `SELECT count(*) || '|' || count(*) FILTER (WHERE v.vb_id IS NOT NULL AND v.ts <> b.ts) FROM ${BACKUP_TABLE} b LEFT JOIN memories_verbatim v ON v.vb_id = b.vb_id;`;
}

/** 落在给定 project 之下的会话节点（不含 project 节点本身）。前缀逐行 starts_with
 *  （ANY 只配操作符不配函数，前缀也不必转义成 LIKE/正则）。 */
export function sqlDbContexts(projects: string[]): string {
  const prefs = projects.map(p => `(${lit(`${p}/`)})`).join(',');
  return `SELECT context_id FROM contexts WHERE EXISTS (SELECT 1 FROM (VALUES ${prefs}) AS p(pref) WHERE starts_with(context_id, p.pref)) ORDER BY 1;`;
}

/** 施加 source 态（单事务）：备份规划会话内还没备份的行 → 改时刻。备份表无主键、靠
 *  NOT EXISTS 增量——只在锁内写，不会重；vb_id / ts 两列类型随 memories_verbatim 继承。
 *  改动行数须经 RETURNING 取——裸 UPDATE 的输出是命令标签「UPDATE n」，不是数。 */
export function sqlEnsure(targets: RowTimeTarget[]): string {
  const ctx = ctxArray(plannedContexts(targets));
  return [
    'BEGIN;',
    `SELECT ${LOCK};`,
    `CREATE TABLE IF NOT EXISTS ${BACKUP_TABLE} AS SELECT vb_id, ts FROM memories_verbatim WITH NO DATA;`,
    `INSERT INTO ${BACKUP_TABLE} (vb_id, ts) SELECT v.vb_id, v.ts FROM memories_verbatim v WHERE v.context_id = ANY (${ctx}) AND NOT EXISTS (SELECT 1 FROM ${BACKUP_TABLE} b WHERE b.vb_id = v.vb_id);`,
    `WITH u AS (UPDATE memories_verbatim v SET ts = m.ts FROM (VALUES ${planValues(targets)}) AS m(ctx, ts) WHERE v.context_id = m.ctx AND v.ts <> m.ts RETURNING 1) SELECT 'changed=' || count(*) FROM u;`,
    'COMMIT;',
  ].join('\n');
}

/** 对账（只读）：规划会话内 时刻 ≠ 规划值的行 | 未入备份的行 | 规划会话总行数 | 备份表总行数。 */
export function sqlReconcile(targets: RowTimeTarget[]): string {
  const ctx = ctxArray(plannedContexts(targets));
  return (
    `SELECT (SELECT count(*) FROM memories_verbatim v JOIN (VALUES ${planValues(targets)}) AS m(ctx, ts) ON v.context_id = m.ctx WHERE v.ts <> m.ts)` +
    ` || '|' || (SELECT count(*) FROM memories_verbatim v WHERE v.context_id = ANY (${ctx}) AND NOT EXISTS (SELECT 1 FROM ${BACKUP_TABLE} b WHERE b.vb_id = v.vb_id))` +
    ` || '|' || (SELECT count(*) FROM memories_verbatim WHERE context_id = ANY (${ctx}))` +
    ` || '|' || (SELECT count(*) FROM ${BACKUP_TABLE});`
  );
}

/** 还原（单事务）：按备份回填 → 残差闸 → 删备份表。残差非 0 由「除零」让整笔事务报错
 *  回滚（备份表保留）——回填与删表在同一事务里，不会出现「表删了、行没回填」。
 *  残差取值用标量子查询直拼（`(SELECT count(*))`）——包一层 `count(*) FROM (子查询)`
 *  数的是子查询的行数（恒 1），不是值。 */
export function sqlRevert(): string {
  const residual = `SELECT count(*) FROM ${BACKUP_TABLE} b JOIN memories_verbatim v ON v.vb_id = b.vb_id WHERE v.ts <> b.ts`;
  return [
    'BEGIN;',
    `SELECT ${LOCK};`,
    `WITH u AS (UPDATE memories_verbatim v SET ts = b.ts FROM ${BACKUP_TABLE} b WHERE v.vb_id = b.vb_id AND v.ts <> b.ts RETURNING 1) SELECT 'restored=' || count(*) FROM u;`,
    `SELECT 'diff=' || (${residual});`,
    `SELECT 1 / ((${residual}) = 0)::int;`,
    `DROP TABLE IF EXISTS ${BACKUP_TABLE};`,
    'COMMIT;',
  ].join('\n');
}

// ------------------------------------------------------------------ 库访问面

export interface RowTimeEnsureResult {
  /** 本次施加实际改动的行数（已在 source 态的行不计） */
  changed: number;
  /** 规划会话内的原文行总数 */
  planned: number;
  /** 备份表总行数（含别的轮留下、尚未还原的） */
  backed: number;
}

/** 对账读数（sqlReconcile 的解析形）。 */
export interface RowTimeReconcile {
  /** 规划会话内 时刻 ≠ 规划值的行数 */
  mismatch: number;
  /** 规划会话内 未入备份的行数 */
  unbacked: number;
  /** 规划会话内原文行总数 */
  planned: number;
  /** 备份表总行数 */
  backed: number;
}

/** 库访问面：真身 = psql（psqlRowTimeStore），单测给脚本化的假身。 */
export interface RowTimeStore {
  backupExists(): Promise<boolean>;
  /** 备份对账：备份总行数 / 其中已改的行数。备份表不在 → null。 */
  backupStats(): Promise<{ backed: number; patched: number } | null>;
  /** 落在给定 project 之下的会话节点（含答题节点）。 */
  contextsUnder(projects: string[]): Promise<string[]>;
  /** 施加 source 态 + 对账：规划会话内每行时刻 = 规划值、全部已备份。不平即抛。 */
  ensure(targets: RowTimeTarget[]): Promise<RowTimeEnsureResult>;
  /** 对账（只读）。备份表不在时 backed = 0。 */
  reconcile(targets: RowTimeTarget[]): Promise<RowTimeReconcile>;
  /** 还原到 replay 态（回填 + 删备份表同事务）；残差非 0 即抛（库停在 source 态、备份表保留）。返回还原行数。 */
  revert(): Promise<number>;
}

/** SQL → psql（异步：持有租约的进程在跑库操作时也要应得了租约探询，见文件头）。
 *  -qAt：只出查询行、不出命令标签；ON_ERROR_STOP：任一语句失败即非零退出——事务内失败
 *  = 未提交即断连 = 回滚。 */
function psql(dbName: string, sql: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      path.join(pgBinDir(), 'psql.exe'),
      ['-h', PG_CONN.host, '-p', String(PG_CONN.port), '-U', PG_CONN.user, '-d', dbName, '-v', 'ON_ERROR_STOP=1', '-qAt', '-f', '-'],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    );
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d: string) => { out += d; });
    child.stderr.on('data', (d: string) => { err += d; });
    const timer = setTimeout(() => {
      child.kill(); // 断连 = 未提交的事务回滚
      reject(new Error('psql 超时（180s）已终止——事务内未提交的改动随断连回滚'));
    }, 180_000);
    child.on('error', e => {
      clearTimeout(timer);
      reject(new Error(`psql 起不来：${e.message}`));
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`psql 失败（exit ${code}）：${err.trim().slice(0, 600)}`));
    });
    child.stdin.end(sql, 'utf8');
  });
}

const num = (s: string): number => {
  const n = Number(s.trim());
  if (!Number.isInteger(n) || n < 0) throw new Error(`psql 返回了非负整数以外的值：${JSON.stringify(s.slice(0, 80))}`);
  return n;
};
/** 取 `<key>=<n>` 形态的输出行（事务输出里空行 / 别的标记混排，按键取不按下标取）。 */
const flagged = (out: string, key: string): number => {
  const line = out.split(/\r?\n/).map(l => l.trim()).find(l => l.startsWith(`${key}=`));
  if (line === undefined) throw new Error(`psql 输出缺 ${key}= 行：${out.slice(0, 200)}`);
  return num(line.slice(key.length + 1));
};

const parseReconcile = (raw: string): RowTimeReconcile => {
  const m = /^(\d+)\|(\d+)\|(\d+)\|(\d+)$/.exec(raw.trim());
  if (!m) throw new Error(`行时刻对账读数形状不对：${raw.slice(0, 120)}`);
  const [mismatch, unbacked, planned, backed] = m.slice(1).map(num);
  return { mismatch, unbacked, planned, backed };
};

export function psqlRowTimeStore(dbName: string): RowTimeStore {
  const q = (sql: string) => psql(dbName, sql);
  const backupExists = async (): Promise<boolean> => num(await q(sqlBackupTableExists())) > 0;
  const backupStats: RowTimeStore['backupStats'] = async () => {
    if (!(await backupExists())) return null;
    const m = /^(\d+)\|(\d+)$/.exec((await q(sqlBackupStats())).trim());
    if (!m) throw new Error('备份对账读数形状不对（应为 <总行>|<已改行>）');
    return { backed: num(m[1]!), patched: num(m[2]!) };
  };
  const revert: RowTimeStore['revert'] = async () => {
    let out: string;
    try {
      out = await q(sqlRevert());
    } catch (err) {
      if (/division by zero/.test((err as Error).message)) {
        throw new Error('还原后仍有行与备份不一致——整笔回滚，库停在 source 态、备份表保留；排查后再还原');
      }
      throw err;
    }
    return flagged(out, 'restored');
  };
  const reconcile = async (targets: RowTimeTarget[]): Promise<RowTimeReconcile> => {
    if (plannedContexts(targets).length === 0) return { mismatch: 0, unbacked: 0, planned: 0, backed: 0 };
    const rec = parseReconcile(await q(sqlReconcile(targets)));
    return (await backupExists()) ? rec : { ...rec, backed: 0 };
  };
  const ensure = async (targets: RowTimeTarget[]): Promise<RowTimeEnsureResult> => {
    if (plannedContexts(targets).length === 0) return { changed: 0, planned: 0, backed: 0 };
    const changed = flagged(await q(sqlEnsure(targets)), 'changed');
    const rec = await reconcile(targets);
    if (rec.mismatch !== 0 || rec.unbacked !== 0) {
      throw new Error(
        `行时刻对账不平：${rec.mismatch} 行时刻 ≠ 规划值 / ${rec.unbacked} 行未入备份（规划 ${rec.planned} 行，备份表 ${rec.backed} 行）` +
        `——执行 npx tsx lmg/row-time.ts revert 还原后排查`,
      );
    }
    return { changed, planned: rec.planned, backed: rec.backed };
  };
  return {
    backupExists,
    backupStats,
    async contextsUnder(projects) {
      if (projects.length === 0) return [];
      return (await q(sqlDbContexts(projects))).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    },
    ensure,
    reconcile,
    revert,
  };
}

// ------------------------------------------------------------------ 租约（轮次判活）

export type RowTimePhase = 'active' | 'ending';

/** 在跑的 qa 轮的自报（管道对端连上来即回一行 JSON）。 */
export interface RowTimePeer {
  mode: RowTimeMode;
  pid: number;
  /** 起租时刻（ISO） */
  at: string;
  /** 人读标签（臂 / 臂-tag） */
  label: string;
  /** active = 答题中；ending = 已进收尾（source 态下可能正在还原） */
  phase: RowTimePhase;
}

export interface RowTimeLease {
  readonly self: Readonly<RowTimePeer>;
  /** 同库在跑的其他轮（自己不算）。 */
  peers(): Promise<RowTimePeer[]>;
  /** 标记进入收尾（自报面随之变；租约仍在）。 */
  markEnding(): void;
  /** 撤租约；撤后 peers() 仍可探别的轮。可重复调。 */
  close(): Promise<void>;
}

/** 每库的租约槽位数 = 同库可登记的轮数上限。 */
export const ROW_TIME_SLOTS = 16;

/** 探一个槽位的耐心：只在「连得上却不应答」时才花——持有者事件循环被占死才算；连不上即时返回。 */
const PROBE_TIMEOUT_MS = 3_000;

function pipeName(dbName: string, slot: number): string {
  return `\\\\.\\pipe\\lmg-bench-rowtime-${dbName}-${slot}`;
}

/** 探一个槽位：连得上并读回一行合法自报 = 那里有轮在跑；连不上 / 超时 / 回文不成形 = 没有。 */
function probe(pipe: string): Promise<RowTimePeer | null> {
  return new Promise(resolve => {
    const sock = net.createConnection(pipe);
    let buf = '';
    let done = false;
    const finish = (v: RowTimePeer | null) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(PROBE_TIMEOUT_MS, () => finish(null));
    sock.once('error', () => finish(null));
    sock.once('end', () => finish(null));
    sock.on('data', d => {
      buf += String(d);
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      try {
        const p = JSON.parse(buf.slice(0, nl)) as Partial<RowTimePeer> | null;
        finish(
          p && typeof p.mode === 'string' && typeof p.pid === 'number' && typeof p.label === 'string'
            ? { mode: p.mode as RowTimeMode, pid: p.pid, at: String(p.at ?? ''), label: p.label, phase: p.phase === 'ending' ? 'ending' : 'active' }
            : null,
        );
      } catch {
        finish(null);
      }
    });
  });
}

export async function acquireRowTimeLease(dbName: string, self: Omit<RowTimePeer, 'phase'>): Promise<RowTimeLease> {
  if (process.platform !== 'win32') {
    throw new Error('行时刻租约目前只支持 Windows（命名管道判活）');
  }
  if (!/^[\w-]+$/.test(dbName)) throw new Error(`库名含不能进管道名的字符：${dbName}`);
  const me: RowTimePeer = { ...self, phase: 'active' };
  for (let slot = 0; slot < ROW_TIME_SLOTS; slot++) {
    const server = net.createServer();
    const sockets = new Set<net.Socket>();
    let closed = false;
    server.on('connection', sock => {
      sockets.add(sock);
      sock.on('close', () => sockets.delete(sock));
      sock.on('error', () => {});
      // 一问一答即断；对端卡死不读也不能拖住撤租约（1s 后强拆）
      sock.end(`${JSON.stringify(me)}\n`);
      setTimeout(() => sock.destroy(), 1000).unref();
    });
    const listening = await new Promise<boolean>(resolve => {
      server.once('error', () => resolve(false));
      server.listen(pipeName(dbName, slot), () => resolve(true));
    });
    if (!listening) continue;
    // 起来之后的运行期错误（探针端异常断连等）不得掀翻持有者——答题循环在本进程
    server.on('error', () => {});
    return {
      self: me,
      async peers() {
        const out: RowTimePeer[] = [];
        for (let s = 0; s < ROW_TIME_SLOTS; s++) {
          if (s === slot && !closed) continue;
          const peer = await probe(pipeName(dbName, s));
          if (peer) out.push(peer);
        }
        return out;
      },
      markEnding() {
        me.phase = 'ending';
      },
      async close() {
        if (closed) return;
        closed = true;
        for (const s of sockets) s.destroy();
        await new Promise<void>(resolve => {
          server.close(() => resolve());
          setTimeout(resolve, 2000).unref(); // 兜底：撤租约不得成为驱动退不出的原因
        });
      },
    };
  }
  throw new Error(`行时刻租约槽位用尽（同库已登记 ${ROW_TIME_SLOTS} 个轮？）——npx tsx lmg/row-time.ts status 看在跑的轮`);
}

// ------------------------------------------------------------------ 开局 / 收尾

export interface RowTimeHandle {
  readonly mode: RowTimeMode;
  /** 轮终收尾（驱动的 finally 里调）；可重复调，第二次起空转。 */
  end(): Promise<void>;
}

const describePeers = (peers: RowTimePeer[]) => peers.map(p => `${p.label}（pid ${p.pid}）`).join('，');

/** 等收尾中的轮消失（它们撤租约 = 该做的还原已做完）。超时即抛——不带着「以为等到了」往下走。 */
async function waitEndingGone(lease: RowTimeLease): Promise<void> {
  const deadline = Date.now() + 120_000;
  for (;;) {
    const ending = (await lease.peers()).filter(p => p.phase === 'ending');
    if (ending.length === 0) return;
    if (Date.now() > deadline) {
      throw new Error(`收尾中的 qa 轮迟迟不退出（${describePeers(ending)}）——等它结束；确认卡死就停掉它的进程，再 npx tsx lmg/row-time.ts status 核库态`);
    }
    await sleep(250);
  }
}

/** 开局：租约已在手 → 按态开局。任何一步失败都先撤租约再抛（不留「幽灵在跑」）。 */
export async function beginRowTime(opts: {
  mode: RowTimeMode;
  lease: RowTimeLease;
  store: RowTimeStore;
  targets: RowTimeTarget[];
  log?: (msg: string) => void;
}): Promise<RowTimeHandle> {
  const { mode, lease, store, targets } = opts;
  const log = opts.log ?? (() => {});
  let ended = false;
  try {
    await waitEndingGone(lease);
    const peers = await lease.peers();
    if (peers.length > 0) {
      const modes = [...new Set(peers.map(p => `--row-time=${p.mode}`))].join('、');
      throw new Error(
        `同库已有 ${peers.length} 个 qa 轮在跑（${modes}，${describePeers(peers)}）` +
        `——bench daemon 是同一个，重叠轮互踩；等它们结束（最后退出的 source 轮自动还原）或停掉后再跑，` +
        `npx tsx lmg/row-time.ts status 可看在跑轮的 pid`,
      );
    }
    if (mode === 'source') {
      assertRowTimeGeometry(targets, await store.contextsUnder(targets.map(t => t.project)));
      const r = await store.ensure(targets);
      log(`行时刻：source 态 ✓（${targets.length} 题 / ${plannedContexts(targets).length} 会话 / 本轮改 ${r.changed} 行 / 备份表 ${r.backed} 行）`);
    } else if (await store.backupExists()) {
      const restored = await store.revert();
      log(`行时刻：库停在 source 态（上一轮没还原）——已自动还原 ${restored} 行`);
    } else {
      log('行时刻：replay（缺省）');
    }
  } catch (err) {
    await lease.close().catch(() => {});
    throw err;
  }
  return {
    mode,
    async end() {
      if (ended) return;
      ended = true;
      try {
        if (mode !== 'source') return;
        // 先标 ending、租约不撤去探同态在跑的轮（见文件头「交接」）
        lease.markEnding();
        const rest = (await lease.peers()).filter(p => p.mode === 'source' && p.phase !== 'ending');
        if (rest.length > 0) {
          log(`行时刻：还有 ${rest.length} 个 source 轮在跑（${describePeers(rest)}）——还原交给最后退出的那个`);
          return;
        }
        if (!(await store.backupExists())) return;
        const restored = await store.revert();
        log(`行时刻：已还原到 replay 态（${restored} 行，备份表已删）`);
      } finally {
        await lease.close();
      }
    },
  };
}

// ------------------------------------------------------------------ main（手工处置面）

/** 规划 ↔ 库：几何对账 + 对账读数（source 态才有）。结论进文本，不抛——status 是看现场的面。 */
async function describePlan(store: RowTimeStore, targets: RowTimeTarget[]): Promise<string> {
  if (targets.length === 0) return '规划：题集为空';
  const lines = [`规划：${targets.length} 题 / ${plannedContexts(targets).length} 会话`];
  try {
    assertRowTimeGeometry(targets, await store.contextsUnder(targets.map(t => t.project)));
    lines.push('库几何：与规划一一对应 ✓');
  } catch (err) {
    lines.push(`库几何：不平 ✗——${(err as Error).message}`);
    return lines.join('\n');
  }
  if (!(await store.backupExists())) return lines.join('\n');
  const r = await store.reconcile(targets);
  lines.push(`规划会话对账：${r.planned} 行 / 时刻 ≠ 规划值 ${r.mismatch} / 未入备份 ${r.unbacked}（备份表 ${r.backed} 行）`);
  return lines.join('\n');
}

async function main(cmd: 'status' | 'revert'): Promise<void> {
  const args = parseArgs(process.argv.slice(3));
  const cfg = loadChainEnv(args.dataset === 'locomo' ? 'locomo' : 'lme');
  const ds = loadPack(cfg.dataDir, args.dataset === 'locomo' ? 'locomo' : 'lme');
  const idList = (JSON.parse(readFileSync(args.ids ?? path.join(benchRoot, 'frozen', 'lme-126.json'), 'utf8')) as { questionIds?: string[] }).questionIds ?? [];
  const byId = new Map(ds.questions.map(q => [q.id, q] as const));
  const targets = planRowTime(idList.map(id => byId.get(id)).filter((q): q is PackQuestion => !!q), ds.conversations ?? []);
  const store = psqlRowTimeStore(cfg.dbName);
  // 手工面也登记租约：还原期间新起的 source 轮会把本进程当在跑的轮拒掉，不会半路插进来
  const lease = await acquireRowTimeLease(cfg.dbName, {
    mode: 'replay', pid: process.pid, at: new Date().toISOString(), label: `row-time ${cmd}`,
  });
  try {
    let peers = await lease.peers();
    const ending = peers.filter(p => p.phase === 'ending');
    if (ending.length > 0) {
      console.log(`等收尾中的 qa 轮退出（${describePeers(ending)}）…`);
      await waitEndingGone(lease);
      peers = await lease.peers();
    }
    const patched = await store.backupExists();
    console.log(`db=${cfg.dbName}  行时刻态：${patched ? 'source（备份表在场 = 行时刻已改、未还原）' : 'replay（库的快照态）'}`);
    console.log(await describePlan(store, targets));
    if (patched) {
      const s = await store.backupStats();
      console.log(`备份对账：备份 ${s?.backed} 行 / 其中已改 ${s?.patched} 行`);
    }
    console.log(peers.length > 0
      ? `在跑的 qa 轮：${peers.map(p => `${p.label}（${p.mode}，pid ${p.pid}）`).join('，')}`
      : '在跑的 qa 轮：无');
    if (cmd === 'revert') {
      const live = peers.filter(p => p.mode === 'source');
      if (live.length > 0) {
        throw new Error(`有 ${live.length} 个 source 轮在跑（${describePeers(live)}）——现在还原会让它们后半程读到回放时刻；等它们结束（最后退出的那个自动还原）`);
      }
      console.log(patched ? `已还原 ${await store.revert()} 行，备份表已删` : '库已在 replay 态——无可还原');
    }
  } finally {
    await lease.close();
  }
}

if (isProcessEntry(import.meta.url)) {
  if (process.argv[2] !== 'status' && process.argv[2] !== 'revert') {
    console.error('用法：npx tsx lmg/row-time.ts status|revert [--ids=<题集清单>]');
    process.exit(2);
  }
  main(process.argv[2] as 'status' | 'revert').catch(err => {
    console.error(String((err as Error).stack ?? err));
    process.exit(1);
  });
}
