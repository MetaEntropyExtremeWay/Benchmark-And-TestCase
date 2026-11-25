/**
 * lmg 产品链 formation 驱动——把 frozen 清单的 LME haystack 经真实写链灌入冻结库。
 *
 * 本驱动建「读侧评测的冻结底座」——坐标按数据源拓扑定（chain 几何，单源
 * shared/coords.ts），formation 幂等重入同一库，库成型后 pg_dump 快照、每臂 restore。
 * 写链走产品现成 replay 子命令：题面 JSONL 直拼 history + 逐轮 verbatim 直存
 * （LMG_VERBATIM=on）+ auto 捕获 + closeout 晋升入队（收尾评估在 daemon 收尾 worker，
 * 本驱动起 daemon 时显式 LMG_CLOSEOUT_WORKER=on——worker 两态缺省关，不开则晋升
 * 永不评估，库少一层）。
 *
 * 几何（单源 shared/coords.ts）：每题一 project /root/bench-<dataset>-<qid>（一个「用户」的
 * 记忆域，跨题零串台）→ 源会话按时序各一 session 子节点 s-<i>-<源sid>。formation 钉
 * LMG_MEM_CONTEXT（钉挂载点形态不建链）→ context 链由本驱动经 MemClient 显式预建
 * （几何全在驱动手里，不靠产品推断）。语料 = 每题 haystack 全量（**含金标会话**：
 * LME 协议 gold ⊆ haystack，答案会话是语料本体，剥了它所有臂只能答不知道）；
 * 「金标不进题面」由题面构造面保证（basePrompt 只含问句/hint/格式行）。
 * goldIncluded 计入 manifest，=0 的题读数无效。
 *
 * ts 注入（--ts=on，缺省关）：题面行带源会话日期（毫秒）→ verbatim 行源时间戳。
 * 缺省全体等新（freshness 按 wall-clock）——取舍：开 ts 会造成 verbatim 行源时钟
 * 与晋升条目 formation 时钟的混钟态（晋升 created_at 恒为灌库时刻），全等新单一失真
 * 源、臂间一致，更好判读；能力保留，升级重灌即启用。
 *
 * 排空与收口：outbox/verbatim 队列排空（health）+ 收尾事件全落定（closeout_event
 * 无 pending/claimed，经 psql 计数——库级排空判据无产品读面）+ unevaluated-sessions
 * 清空（产品面）+ 条目向量全落定（memories/memories_verbatim emb pending=0，psql——
 * 向量没落定的行 search 读不到，且快照带 pending 行会被 restore 后的 embed 轮询续写）
 * + sweep 兜底踢（daemon admin，PROMOTION_DEFERRED 的存量收编）。
 *
 * 并发模型：题内会话按 date 串行（晋升链写入时序贴对话时序），题间并行（--jobs 缺省 2）。
 * 进度账本按 (qid,sid) 原子落盘：done 跳过、error 重跑——中断后同命令重入。
 * 额度窗（LLM 5h 窗/周额度）：连续多槽撞 429/限额 → 熔断提前中止（防额度死后几千槽
 * 空转数小时）；嵌入死信（emb_status=failed）重排回 pending 供轮询重嵌；也可用
 * shared/quota-run.ts 包装在重置点自动续跑同命令。
 *
 * 用法：
 *   npx tsx lmg/formation.ts --dataset=lme [--ids=frozen/lme-126.json] [--jobs=2]
 *                            [--limit-q=N --limit-s=N]（冒烟）[--ts=on] [--verify] [--skip-replay]
 *   前置：shared\scripts\mem-bench-app.ps1 start -Dataset lme -Line lmg（8084 / lmg_mem_bench_lme_chain）
 *   冒烟单题全链：--limit-q=1 --limit-s=3（前三会话）→ --verify 看三层可见性
 *   --verify --skip-replay：不动库只跑断言（冒烟后快速复检）
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../shared/args.ts';
import { benchRoot, lmgRoot, loadChainEnv, pgBinDir, PG_CONN } from '../shared/config.ts';
import { isProcessEntry } from '../shared/entry.ts';
import { loadPack, type PackConversation, type PackQuestion } from '../shared/pack.ts';
import { conversationsByDate, conversationsInScope } from '../datasets/dialogue.ts';
import { MemClient, sleep } from '../shared/mem.ts';
import { benchProjectId, benchFormationSession, chainRunDir } from '../shared/coords.ts';
import { retryOnTransientLock } from '../shared/retry.ts';
import { ensureChainDaemon, shutdownChainDaemon, EXO_DIR } from '../shared/daemon.ts';
import type { PackQuestion } from '../shared/pack.ts';

const EXO_ROOT = lmgRoot();
const TSX = path.join(EXO_ROOT, 'node_modules', '.bin', 'tsx.cmd');
const RUN_ID = 'form'; // 链线 formation 固定 runId：库是规范底座（几何坐标不含 runId），重入续跑
const REPLAY_TIMEOUT_MS = 600_000; // 单回放墙钟兜底：长会话放宽 10min

interface ProgressEntry {
  status: 'done' | 'error';
  exitCode: number | null;
  at: string;
}

function loadProgress(file: string): Record<string, Record<string, ProgressEntry>> {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function saveProgress(file: string, progress: Record<string, Record<string, ProgressEntry>>): void {
  const body = JSON.stringify(progress, null, 1);
  const tmp = file + '.tmp';
  writeFileSync(tmp, body, 'utf8');
  // Windows 热账本 rename 偶发瞬态锁（Defender/索引器占用目标——全量
  // formation 1950/2358 实发整链中止；v1 mem 侧同坑先例见 state.ts 2026-09-23 注）：
  // 复用其重试，耗尽再放弃原子性直写兜底——账本只在本驱动启动时读，撕裂窗无害。
  try {
    retryOnTransientLock(() => renameSync(tmp, file));
  } catch {
    writeFileSync(file, body, 'utf8');
  }
}

// ------------------------------------------------------------------ 纯函数面（单测直测）

/** 会话日期 → 毫秒时间戳（当日正午 UTC——避开时区边界与零点歧义）。坏日期抛错：
 *  ts 模式下静默漏 ts = 时间轴失真比报错更糟（与 replay.ts 解析纪律同口径）。
 *  日期段收两种形态：`YYYY-MM-DD` 与 `YYYY/MM/DD`（LME haystack_dates
 *  原样带空格后的「(周几) HH:mm」——loader 不归一）；日期段之后的内容丢弃（源数据
 *  粒度即会话级，时刻统一取正午）。 */
export function dateToEpochMs(date: string): number {
  const m = /^(\d{4})([-/])(\d{2})\2(\d{2})(?:\s.*)?$/.exec(date.trim());
  const ms = m ? Date.parse(`${m[1]}-${m[3]}-${m[4]}T12:00:00Z`) : NaN;
  if (!Number.isFinite(ms)) throw new Error(`会话日期不可解析：${JSON.stringify(date)}（日期段须 YYYY-MM-DD 或 YYYY/MM/DD）`);
  return ms;
}

/** 对话 turns → replay JSONL（replay 消费对话形态——产品写链的输入形状）；
 *  tsMode 时每行带 ts 键（全对话同 ts：源数据日期粒度即会话级，轮内序由 seq 承载）。
 *  非 user/assistant 角色 fail-fast（灌录输入不许脏数据静默跳行）。 */
export function conversationToReplayLines(conversation: PackConversation, tsMode: boolean): string {
  const ts = tsMode ? dateToEpochMs(conversation.date ?? '') : undefined;
  const lines: string[] = [];
  for (const turn of conversation.turns) {
    if (turn.speaker === 'user') {
      if (!turn.text.trim()) continue;
      lines.push(JSON.stringify(tsMode ? { user: turn.text, ts } : { user: turn.text }));
    } else if (turn.speaker === 'assistant') {
      if (!turn.text.trim()) continue;
      lines.push(JSON.stringify(tsMode ? { assistant: turn.text, ts } : { assistant: turn.text }));
    } else {
      throw new Error(`对话 ${conversation.key} 有非 user/assistant 角色：${turn.speaker}（灌录输入不许脏数据静默跳行）`);
    }
  }
  return lines.join('\n') + '\n';
}

export interface FormationSlot {
  qid: string;
  project: string;
  index: number;
  convKey: string;
  context: string;
  conversation: PackConversation;
}

/** 单题 formation 计划：scope 对话全量（**金标对话在内**——对话基准协议 gold ⊆
 *  scope，答案对话是语料的一部分，剥了它所有臂都只能答不知道；「金标不进
 *  题面」由题面构造面保证：basePrompt 只含问句/hint，不含任何语料内容）→
 *  date 时序 → s-<i>-<源会话键> 逐对话坐标。limitS 截前 N 对话（冒烟）。
 *  goldIncluded = 该题金标对话落进槽位的数量——应 >0（=0 即答案不在库里，
 *  该题读数无效，manifest 暴露）。 */
export function formationSlots(
  q: PackQuestion,
  conversations: PackConversation[],
  limitS?: number,
): { slots: FormationSlot[]; goldIncluded: number } {
  const inScope = conversationsInScope(q, conversations);
  const gold = new Set(q.goldKeys);
  const ordered = conversationsByDate(inScope.conversations).slice(0, limitS ?? Infinity);
  const keptGold = new Set(ordered.filter(c => gold.has(c.key)).map(c => c.key));
  const goldIncluded = keptGold.size; // limitS 截断后真正在库里的金标数
  const project = benchProjectId(q.dataset, q.id);
  const slots = ordered.map((conversation, index) => ({
    qid: q.id,
    project,
    index,
    convKey: conversation.key,
    context: benchFormationSession(project, index, conversation.key),
    conversation,
  }));
  return { slots, goldIncluded };
}

/** 题集净化碰撞预检：benchProjectId 段净化（截 80）后两题同段 = 跨题串台，fail-fast。 */
export function assertProjectUnique(questions: PackQuestion[]): void {
  const seen = new Map<string, string>();
  for (const q of questions) {
    const p = benchProjectId(q.dataset, q.id);
    const prev = seen.get(p);
    if (prev !== undefined && prev !== q.id) {
      throw new Error(`project 段净化碰撞：${q.id} 与 ${prev} 同落 ${p}——跨题零串台被破坏，缩短题 id 源或改段名规则`);
    }
    seen.set(p, q.id);
  }
}

// ------------------------------------------------------------------ replay 进程面（daemon 在 shared/daemon.ts 单源）

/** 跑一次回放：env 钉 LMG_MEM_CONTEXT 到该源会话节点（钉挂载点不建链——context 链
 *  已由驱动预建）；LMG_VERBATIM=on 逐轮直存原文层；收尾真实执行（捕获+晋升入队）。 */
async function runReplay(file: string, contextId: string, daemonPort: number): Promise<{ ok: boolean; code: number | null; tail: string; full: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of ['LMG_DAEMON_PORT', 'LMG_MEM_BACKEND', 'LMG_MEM_API', 'LMG_MEM_TOKEN', 'LMG_MEM_PROJECT', 'LMG_MEM_CONTEXT']) {
    delete env[key];
  }
  Object.assign(env, {
    LMG_MEM_BACKEND: 'remote',
    LMG_DAEMON_PORT: String(daemonPort),
    LMG_MEM_CONTEXT: contextId, // 钉挂载点 = 本源会话节点；session 名 s-<i>-<源sid> 在此钉死
    LMG_VERBATIM: 'on', // 原文层逐轮直存（replay 直驱写器装配门）
    LMG_CLOSEOUT: 'on', // 收尾真实执行（捕获 + 晋升入队；两态缺省关）
    LMG_PREFERENCE_MODE: 'auto', // auto 捕获（产品真身收尾链）
    LMG_TEE: '0',
    LMG_LOG: '1',
    LMG_CLOSE_WAIT_MS: '480000', // 收尾同步等待上限（墙钟兜底 600s > 此值 > 收尾预算 300s）
    LMG_MEM_SESSION_STABLE: '0', // 与钉 CONTEXT 无关但显式钉死——产品 .env 若有 =1 不得渗入
    LMG_PROMOTION_RELAY_MAX: '0', // 接力补评关：读数记「预算外」，存量收编走 worker sweep
    LMG_CLOSEOUT_GLOBAL_TIMEOUT_MS: '300000', // 收尾全局预算（让收尾自然跑完，耗时如实入分布）
  });
  const cmdArgs: string[] = [];
  if (existsSync(path.join(EXO_DIR, '.env'))) cmdArgs.push('--env-file=.env');
  cmdArgs.push('src/index.ts', 'replay', file);
  return new Promise(resolve => {
    const child = spawn(TSX, cmdArgs, { cwd: EXO_DIR, env, windowsHide: true, shell: true });
    let full = '';
    let settled = false;
    child.stdout.on('data', (d: Buffer) => { full += d; });
    child.stderr.on('data', (d: Buffer) => { full += d; });
    const timer = setTimeout(() => {
      if (child.pid) spawn('taskkill', ['/PID', String(child.pid), '/T', '/F']);
    }, REPLAY_TIMEOUT_MS);
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, code, tail: full.slice(-1500), full });
    };
    child.on('close', finish);
    child.on('error', err => { full += String(err); finish(null); });
  });
}

// ------------------------------------------------------------------ 库级排空 / 断言

/** closeout_event 未落定计数（pending/claimed）——库级排空判据，无产品读面走 psql。 */
function closeoutPending(dbName: string): number {
  const psql = path.join(pgBinDir(), 'psql.exe');
  const r = spawnSync(psql, [
    '-h', PG_CONN.host, '-p', String(PG_CONN.port), '-U', PG_CONN.user, '-d', dbName, '-tAc',
    "SELECT count(*) FROM closeout_event WHERE status IN ('pending','claimed')",
  ], { encoding: 'utf8', timeout: 15_000 });
  if (r.status !== 0) throw new Error(`psql 排空计数失败：${String(r.stderr).slice(0, 300)}`);
  return Number(r.stdout.trim()) || 0;
}

/** embedding 未落定计数（活行：memories emb_status='pending' AND status='active'，加
 *  memories_verbatim pending——verbatim 无 status 列）。**只数活行**：被晋升 tombstone 的
 *  session 行（status=destroyed）其 index 事件按设计跳过嵌入（防僵尸复活），永远 pending
 *  且不可检索——数上它们排空永不归零（冒烟实测）。向量没落定的活行 search 读不到（verify
 *  抢跑即漏计）；更要紧的是快照带 pending 活行的话，restore 后实例的索引消费会继续写库、
 *  打穿「每臂前复位到同一态」——排空必须清到零。failed 活行直接抛（嵌入断层 = 断层面，
 *  继续跑只会产出读不到的库）。无产品读面，走 psql。 */
function embedPending(dbName: string): number {
  const psql = path.join(pgBinDir(), 'psql.exe');
  const sql = "SELECT (SELECT count(*) FROM memories WHERE emb_status='pending' AND status='active') + (SELECT count(*) FROM memories_verbatim WHERE emb_status='pending')";
  const r = spawnSync(psql, [
    '-h', PG_CONN.host, '-p', String(PG_CONN.port), '-U', PG_CONN.user, '-d', dbName, '-tAc', sql,
  ], { encoding: 'utf8', timeout: 15_000 });
  if (r.status !== 0) throw new Error(`psql 嵌入计数失败：${String(r.stderr).slice(0, 300)}`);
  const failed = spawnSync(psql, [
    '-h', PG_CONN.host, '-p', String(PG_CONN.port), '-U', PG_CONN.user, '-d', dbName, '-tAc',
    "SELECT count(*) FROM memories WHERE emb_status='failed' AND status='active'",
  ], { encoding: 'utf8', timeout: 15_000 });
  if (Number(failed.stdout.trim()) > 0) {
    throw new Error(`${dbName} 有活的 emb_status='failed' 行——嵌入断层（embed API 凭据/网络？），先修再续跑`);
  }
  return Number(r.stdout.trim()) || 0;
}

/** 额度窗内嵌入退避耗尽的死信行（emb_status=failed）不会自愈——embed 轮询只捡
 *  pending。重入时把 failed 翻回 pending 让轮询重试（额度已恢复的续跑场景；再失败
 *  会再死信，drainAll 兜底抛错走 quota-run 重试环）。无产品读面，走 psql。 */
function requeueFailedEmbeds(dbName: string): number {
  const psql = path.join(pgBinDir(), 'psql.exe');
  const sql = "UPDATE memories SET emb_status='pending' WHERE emb_status='failed' AND status='active'; UPDATE memories_verbatim SET emb_status='pending' WHERE emb_status='failed'";
  const r = spawnSync(psql, [
    '-h', PG_CONN.host, '-p', String(PG_CONN.port), '-U', PG_CONN.user, '-d', dbName, '-c', sql,
  ], { encoding: 'utf-8', timeout: 30_000 });
  if (r.status !== 0) throw new Error(`psql 死信重排失败：${String(r.stderr).slice(0, 300)}`);
  const nums = (String(r.stdout).match(/UPDATE (\d+)/g) ?? []).map(s => Number(s.replace(/\D+/g, '')));
  return nums.reduce((a, b) => a + b, 0);
}

/** 踢 daemon 收尾 worker sweep（PROMOTION_DEFERRED 存量收编兜底）。best-effort。 */
async function kickSweep(port: number): Promise<void> {
  try {
    await fetch(`http://127.0.0.1:${port}/closeout?action=sweep`, { method: 'POST', signal: AbortSignal.timeout(30_000) });
  } catch { /* worker 轮询自会消费；踢失败不阻断 */ }
}

/** 排空收口：embed outbox → 收尾事件全落定 → unevaluated 清空 → 向量全落定。
 *  中途每周期间隔踢 sweep。 */
async function drainAll(mem: MemClient, dbName: string, daemonPort: number, budgetMs: number, log: (m: string) => void): Promise<void> {
  const start = Date.now();
  for (let round = 1; ; round++) {
    const h = await mem.health();
    const events = closeoutPending(dbName);
    const emb = embedPending(dbName);
    const uneval = await mem.unevaluatedSessions(500);
    const busy = h.outboxPending > 0 || h.verbatimPending > 0 || events > 0 || uneval.length > 0 || emb > 0;
    if (!busy) {
      log(`排空完成（round ${round}）：outbox=0 / verbatim=0 / closeout_event=0 / unevaluated=0 / embed=0`);
      return;
    }
    if (Date.now() - start > budgetMs) {
      throw new Error(`排空超预算（${Math.round(budgetMs / 60000)}min）：outbox=${h.outboxPending} verbatim=${h.verbatimPending} closeout_event=${events} unevaluated=${uneval.length} embed=${emb}——看 mem 日志与 daemon 收尾日志再续跑`);
    }
    if (round % 5 === 1) {
      log(`排空 round ${round}：outbox=${h.outboxPending} verbatim=${h.verbatimPending} closeout_event=${events} unevaluated=${uneval.length} embed=${emb}`);
      await kickSweep(daemonPort);
    }
    await sleep(10_000);
  }
}

export interface VerifyRow {
  qid: string;
  verbatimRows: number;
  sessionNodes: number;
  promotedAtProject: number;
  capturedAtSessions: number;
  ok: boolean;
  problems: string[];
}

/** 三层可见性断言（--verify）：①verbatim 行（每源会话节点 recent 非空）②捕获条目
 *  （session 层）③晋升条目（project 层）。条目面 search 沿祖先链（session 锚 ⊇
 *  project 锚、SearchService chainIds），分层断言用集合差分：project 锚命中的
 *  mem_id 全集 = 晋升层；session 锚命中 − project 全集 = session 层捕获。topk=50
 *  下超集排名挤掉 project 行的概率≈0（每题库仅数十行，断言级精度足够）。
 *  驱动退出码只看 verbatim 层（formation 的机械正确性）；捕获/晋升空是「现状诚实
 *  基线」读数（收类边界窄），记 problems 供读数面分桶、不作驱动错误。 */
async function verifyQuestion(mem: MemClient, q: PackQuestion, slots: FormationSlot[]): Promise<VerifyRow> {
  const problems: string[] = [];
  let verbatimRows = 0;
  for (const s of slots) {
    const hits = await mem.verbatimRecent(s.context, 5);
    if (hits.length === 0) problems.push(`verbatim 空：${s.context}`);
    verbatimRows += hits.length;
  }
  const project = slots[0]?.project ?? benchProjectId(dataset, q.id);
  let promotedAtProject = 0;
  let capturedAtSessions = 0;
  try {
    const proj = await mem.search(q.question, project, 50, { reinforce: false, minScore: 0 });
    const projIds = new Set(proj.hits.map(h => h.mem_id));
    promotedAtProject = projIds.size;
    const sessIds = new Set<string>();
    for (const s of slots) {
      const r = await mem.search(q.question, s.context, 50, { reinforce: false, minScore: 0 });
      for (const h of r.hits) sessIds.add(h.mem_id);
    }
    for (const id of sessIds) if (!projIds.has(id)) capturedAtSessions++;
  } catch (e) {
    problems.push(`条目面 search 失败：${String((e as Error).message).slice(0, 120)}`);
  }
  if (promotedAtProject === 0 && capturedAtSessions === 0) {
    problems.push('条目面空（捕获与晋升均零）——收类边界或 worker 未消费，读数面分桶');
  } else if (promotedAtProject === 0) {
    problems.push('晋升层空（有捕获无上收）——晋升面读数 finding');
  }
  // captured=0 且 promoted>0：捕获行全数上收（session 行 tombstone 为 destroyed、
  // 活行在 project）——晋升语义内的正常态，不作 problem。
  const ok = problems.filter(p => p.startsWith('verbatim')).length === 0;
  return { qid: q.id, verbatimRows, sessionNodes: slots.length, promotedAtProject, capturedAtSessions, ok, problems };
}

// ------------------------------------------------------------------ main

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const dataset = args.dataset === 'locomo' ? 'locomo' as const : 'lme' as const;
  const jobs = Math.max(1, Number(args.jobs || 2));
  const limitQ = args['limit-q'] ? Number(args['limit-q']) : undefined;
  const limitS = args['limit-s'] ? Number(args['limit-s']) : undefined;
  const tsMode = args.ts === 'on';
  const verify = !!args.verify;
  const skipReplay = !!args['skip-replay'];

  const cfg = loadChainEnv(dataset);
  const clock = () => { const d = new Date(); const p2 = (n: number) => String(n).padStart(2, '0'); return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`; };
  const log = (msg: string) => console.log(`[chain-form ${clock()}] ${msg}`);

  // —— 题面：frozen 清单 ∩ pack（lme 缺省清单 = frozen/lme-126.json；locomo 缺省全量）——
  const ds = loadPack(cfg.dataDir, dataset);
  const byId = new Map(ds.questions.map(q => [q.id, q]));
  const idList: string[] = args.ids
    ? (JSON.parse(readFileSync(args.ids, 'utf8')) as { questionIds?: string[] }).questionIds ?? []
    : dataset === 'lme'
      ? (JSON.parse(readFileSync(path.join(benchRoot, 'frozen', 'lme-126.json'), 'utf8')) as { questionIds: string[] }).questionIds ?? []
      : ds.questions.map(q => q.id);
  if (idList.length === 0) throw new Error('题集清单为空');
  const missing = idList.filter(id => !byId.has(id));
  if (missing.length > 0) throw new Error(`清单里 ${missing.length} 题不在抽样池：${missing.slice(0, 5).join(', ')}`);
  const picked = (limitQ ? idList.slice(0, limitQ) : idList).map(id => byId.get(id)!);
  assertProjectUnique(picked);
  log(`题集：${picked.length} 题（ts=${tsMode ? 'on' : 'off'}，verify=${verify}，skip-replay=${skipReplay}）`);

  // —— 健康门：链线 mem 实例必须在跑（规范坐标跨域门在 config 内拦错库）——
  const mem = new MemClient({ baseUrl: cfg.memUrl });
  const h = await mem.health();
  if (h.status !== 'UP') throw new Error(`链线 mem 实例 ${cfg.memUrl} 不健康（${h.status}）——先起：shared\\scripts\\mem-bench-app.ps1 start -Dataset ${dataset} -Line lmg`);
  log(`mem ${cfg.memUrl} UP（outbox pending=${h.outboxPending}，db=${cfg.dbName}）`);

  // —— 任务清单（每题 formation 槽位）——
  const runDir = chainRunDir(cfg.stateDir, RUN_ID);
  const replayRoot = path.join(runDir, 'replay');
  const progressFile = path.join(runDir, 'formation-progress.json');
  mkdirSync(replayRoot, { recursive: true });

  if (!ds.conversations || ds.conversations.length === 0) throw new Error(`pack 无 conversations（对话扩展字段）——formation 的写链（产品 replay）只消费对话形态语料；非对话语料走 mc 直测线（prepare 全链）`);
  const plans = picked.map(q => ({ q, ...formationSlots(q, ds.conversations, limitS) }));
  const allSlots = plans.flatMap(p => p.slots);
  const goldMissing = plans.filter(p => p.goldIncluded === 0).length;
  const goldTotal = plans.reduce((a, p) => a + p.goldIncluded, 0);
  log(`槽位：${allSlots.length} 对话位 / ${plans.length} 题（金标在库 ${goldTotal} 对话位${goldMissing > 0 ? `；⚠ ${goldMissing} 题金标零在库——读数无效` : ''}，jobs=${jobs}${limitQ ? `，冒烟 limit-q=${limitQ} limit-s=${limitS}` : ''}）`);
  if (goldMissing > 0 && !limitS) {
    throw new Error(`${goldMissing} 题金标对话零在库（scope 与装载池不交？）——全量跑不许带这种题，先查 adapter`);
  }

  // —— 预建几何链：project 每题一次 + 每槽位 session 子节点（幂等；不建则钉 CONTEXT 的首个写 400）——
  for (const p of plans) {
    if (p.slots.length === 0) continue;
    await mem.ensureContext(p.slots[0].project, 'project', p.q.id);
    for (const s of p.slots) {
      await mem.ensureChildContext(s.context, p.slots[0].project, 'session', s.convKey);
    }
  }
  log(`几何链预建完成：${plans.filter(p => p.slots.length > 0).length} project`);

  let exitCode = 0;
  if (!skipReplay) {
    await ensureChainDaemon(cfg.memUrl, cfg.daemonPort, { closeoutWorker: true }, log);
    try {
      const progress = loadProgress(progressFile);
      let done = 0;
      let errors = 0;
      const mark = (qid: string, convKey: string, entry: ProgressEntry) => {
        (progress[qid] ??= {})[convKey] = entry;
        saveProgress(progressFile, progress);
      };
      // worker 池：题为单位领任务（题内串行贴时序，题间并行）
      let next = 0;
      // 额度窗熔断：连续多槽撞 429/限额（LLM 5h 窗/周额度耗尽）时提前中止——
      // 不熔断会拖着剩余槽位空转数小时；账本已保 done，重置后同命令续跑（quota-run 包装自动接）。
      let quotaStreak = 0;
      let quotaAbort = false;
      const QUOTA_ERR_RE = /429|限额|rate.?limit|quota/i;
      const worker = async () => {
        for (;;) {
          const i = next++;
          if (i >= plans.length || quotaAbort) return;
          const plan = plans[i];
          for (const s of plan.slots) {
            if (quotaAbort) break;
            if (progress[s.qid]?.[s.convKey]?.status === 'done') continue; // 续跑：done 跳过、error 重跑
            const file = path.join(replayRoot, s.qid, `${s.convKey}.jsonl`);
            mkdirSync(path.dirname(file), { recursive: true });
            writeFileSync(file, conversationToReplayLines(s.conversation, tsMode), 'utf8');
            const res = await runReplay(file, s.context, cfg.daemonPort);
            const outDir = path.join(runDir, 'stdout', s.qid);
            mkdirSync(outDir, { recursive: true });
            writeFileSync(path.join(outDir, `${s.convKey}.log`), res.full, 'utf8');
            if (res.ok) {
              done++;
              quotaStreak = 0;
              mark(s.qid, s.convKey, { status: 'done', exitCode: res.code, at: new Date().toISOString() });
              if (done % 25 === 0) log(`进度 ${done}/${allSlots.length}（err ${errors}）`);
            } else {
              errors++;
              mark(s.qid, s.convKey, { status: 'error', exitCode: res.code, at: new Date().toISOString() });
              log(`ERROR ${s.qid}/${s.convKey} exit=${res.code}：${res.tail.slice(0, 300)}`);
              if (QUOTA_ERR_RE.test(res.tail)) {
                quotaStreak++;
                if (quotaStreak >= 8 && !quotaAbort) {
                  quotaAbort = true;
                  log(`连续 ${quotaStreak} 槽撞额度特征（429/限额）——提前中止本轮；进度已落账本，额度重置后同命令续跑`);
                }
              } else {
                quotaStreak = 0;
              }
            }
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(jobs, plans.length) }, worker));
      if (quotaAbort) throw new Error('额度窗中断（连续槽位 429/限额）：done 已落账本，重置后重跑同命令即续（quota-run 包装自动接）');
      log(`回放完成：done ${done} / error ${errors} / 总位 ${allSlots.length}`);

      // —— 排空收口：embed + 收尾事件 + unevaluated（收尾消费节奏 daemon.ts 钉 8路×5s）——
      const requeued = requeueFailedEmbeds(cfg.dbName);
      if (requeued > 0) log(`嵌入死信重排：${requeued} 行 failed → pending（额度窗续跑场景，轮询自会重嵌）`);
      await drainAll(mem, cfg.dbName, cfg.daemonPort, cfg.drainMs, log);

      if (errors > 0) {
        exitCode = 1;
        log('非零退出：回放错误（formation-progress.json 里 error 位重跑即续）');
      }
    } finally {
      if (!(await shutdownChainDaemon(cfg.daemonPort))) {
        log(`警告：daemon :${cfg.daemonPort} 未能在 6s 内停掉——手动 POST /shutdown 或杀进程`);
        exitCode = exitCode || 2;
      } else {
        log('daemon 已停');
      }
    }
  }

  // —— 三层可见性断言（--verify；冒烟口径 = 每题全槽位核 verbatim + 题面探检索层）——
  let verifyRows: VerifyRow[] | undefined;
  if (verify) {
    log('断言：三层可见性（verbatim / 捕获 / 晋升）');
    verifyRows = [];
    let verbatimFail = 0;
    for (const plan of plans) {
      const row = await verifyQuestion(mem, plan.q, plan.slots);
      verifyRows.push(row);
      if (!row.ok) {
        verbatimFail++;
        log(`NOT-OK ${row.qid}：${row.problems.slice(0, 3).join('；')}`);
      }
    }
    const sumPromoted = verifyRows.reduce((a, r) => a + r.promotedAtProject, 0);
    const sumCaptured = verifyRows.reduce((a, r) => a + r.capturedAtSessions, 0);
    log(`断言完成：verbatim 机械面 ${plans.length - verbatimFail}/${plans.length} 题 ok；条目面读数：晋升 ${sumPromoted} / 捕获（未上收）${sumCaptured}（空层属读数面 finding 非驱动错误）`);
    if (verbatimFail > 0) exitCode = exitCode || 3;
  }

  // —— manifest ——
  const manifest = {
    runId: RUN_ID,
    dataset,
    driver: path.relative(benchRoot, fileURLToPath(import.meta.url)),
    idsFile: args.ids ?? (dataset === 'lme' ? 'frozen/lme-126.json（缺省）' : '（pack 全量）'),
    jobs,
    tsMode,
    slots: allSlots.length,
    goldIncluded: goldTotal,
    memUrl: cfg.memUrl,
    dbName: cfg.dbName,
    daemonPort: cfg.daemonPort,
    verify: verifyRows,
    finishedAt: new Date().toISOString(),
  };
  const manifestFile = path.join(runDir, 'formation-manifest.json');
  writeFileSync(manifestFile, JSON.stringify(manifest, null, 1), 'utf8');
  log(`manifest → ${manifestFile}`);
  process.exit(exitCode);
}

// 纯函数面可被单测与其他驱动 import：VITEST 判别 + 入口判别双保险——被 import（如
// lmg/row-time.ts 取槽位规划）时 argv 是调用方的，照着跑必错；只有本件是进程脚本才跑 main
if (!process.env.VITEST && isProcessEntry(import.meta.url)) {
  main().catch(err => {
    console.error(String((err as Error).stack ?? err));
    process.exit(1);
  });
}
