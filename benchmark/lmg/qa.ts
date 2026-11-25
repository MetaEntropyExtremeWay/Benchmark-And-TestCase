/**
 * lmg 产品链答题驱动——lmg 宿主进程形态（pipe）在冻结库上跑题。
 *
 * 臂定义（读面 = ambient + results 双区注入 + 检索工具；「相关的会话」原文读面区
 * 宽度按臂显式钉值，不吃产品缺省漂移）：
 *   default  原文读面区宽 32（LMG_MEM_VERBATIM_TOPK=32）：每回合 query 条件化原文
 *            单发检索的「相关的会话」区进注入面，条目面不动——bench 校准宽度的主力臂
 *   deep     深检索（客户端 LMG_DEEP_RETRIEVAL=on，memory_deep_search 注册）+ 题面带
 *            显式深度检索意图行（产品约定：工具仅显式意图才调用——不带意图 = 注册在场
 *            也零调用）；读面区宽 0（深检索自带原文取回，不叠单发区）
 *
 * 跨臂污染三重控制（runbook 序：每臂前 restore 快照）：答题会话不关（closeout
 * 缺省关、stdin EOF 即退）+ 答题期 daemon 收尾 worker 关（本驱动起 daemon 时显式
 * off）+ 每臂前库复位（snapshot.ts --restore）。
 *
 * 进程形态：每题一个 lmg 宿主进程（pipe 传输——非 TTY 自动上身）。**题面折单行**喂
 * stdin（pipe 一行一回合，多行题面会被拆多回合、后续行被 ask_user 当答案截走）
 * 且 **stdin 保持开**：流式监听 stdout，「答> 」提示符再现 → 写固定应答行
 * （ASK_STEER_LINE，全臂全题同一行）把模型逼回记忆面——pipe 侧 ask_user 的线格式
 * = 问题独立行 +「答> 」等输入，工具名字面量不出 stdout（锚 `ask_user(` 永不命中，
 * 首跑曾 25/50 悬挂）；最终答案行已见（FINAL_ANSWER 任意位置，占位示例除外——模型
 * 可不换行直书；契约字面缺席时认备式标记，见 pickFinalAnswer）且回合收口（`你> `
 * 提示符再现）→ 写 quit + EOF 干净收口。FINAL_ANSWER 抽取取末次命中（题面契约
 * basePrompt 折叠，判分同锚）；经备式标记抽出的答案记 answerVia=fallback（判分照常，
 * 留痕可数）。超时杀树兜底（模型既不答也不问的悬回合记 timeout no-answer）。
 *
 * 用法（benchmark 根；前置 = 库已 formation、当前态为该臂应跑态）：
 *   npx tsx lmg/qa.ts --dataset=lme --arm=default [--ids=frozen/lme-126.json] [--jobs=2]
 *                     [--limit=N] [--timeout-ms=600000] [--skip-existing] [--tag=<后缀>]
 *                     [--row-time=replay|source]
 *   --tag：产物目录隔离——同臂面跑不同题集时，qa-state/judge/stdout 全落 <arm>-<tag>/
 *          （判分侧 judge-qa --arm=<arm>-<tag> 直读，零改码）；答题 context 节点仍按臂名。
 *   --row-time：原文行时刻态（机制面见 lmg/row-time.ts）——replay = 回放时刻（缺省，
 *          库的快照态，不碰库）；source = 源会话日期（轮首按槽位规划把原文行 ts 改过去、
 *          轮终还原，qa-state 每题记 rowTime 字段）。同库异态轮拒跑；续跑换态拒跑
 *          （要换态换 --tag 另起目录）。
 *   冒烟：--limit=2（前 2 题）
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../shared/args.ts';
import { benchRoot, lmgRoot, loadChainEnv } from '../shared/config.ts';
import { loadPack } from '../shared/pack.ts';
import { MemClient } from '../shared/mem.ts';
import { benchProjectId, qaSession, chainRunDir } from '../shared/coords.ts';
import { ensureChainDaemon, shutdownChainDaemon, EXO_DIR } from '../shared/daemon.ts';
import { basePrompt } from '../shared/prompt.ts';
import {
  acquireRowTimeLease, assertRowTimeConsistent, beginRowTime, parseRowTimeMode, planRowTime, psqlRowTimeStore,
} from './row-time.ts';
import type { RowTimeHandle, RowTimeMode } from './row-time.ts';
import type { PackQuestion } from '../shared/pack.ts';

const EXO_ROOT = lmgRoot();
const TSX = path.join(EXO_ROOT, 'node_modules', '.bin', 'tsx.cmd');
const RUN_ID = 'qa'; // 答题产物树（每臂子目录）；库坐标不含 runId（几何定）

/** 臂表：客户端 env 增量（服务端态由 runbook 起）+ 题面附加行。
 *  deep 的附加行 = 显式深度检索意图——产品教学约定 memory_deep_search **仅显式意图
 *  才调用**（常规查询走 search_memory 单发，gather 纪律），不带意图措辞模型守约不调、
 *  臂空转（实测：注册在场零调用）。附加行只此一臂，臂差即「深检索可用 + 显式触发」
 *  的产品完整形态。
 *  「相关的会话」原文读面区宽（LMG_MEM_VERBATIM_TOPK）每臂显式定值——臂面不吃产品
 *  缺省漂移：default 显式 32（bench 校准宽，比产品缺省宽一档——防「区在但太窄取不出
 *  金标」的假阴性），deep 钉 0（深检索自带原文取回，不叠单发区）。 */
const E_ARMS = {
  default: {
    env: { LMG_MEM_VERBATIM_TOPK: '32' },
    promptSuffix: '',
  },
  deep: {
    env: { LMG_DEEP_RETRIEVAL: 'on', LMG_MEM_VERBATIM_TOPK: '0' },
    promptSuffix: ' Before answering, do a deep search of your memory for relevant records.',
  },
} as const;
export type EArmId = keyof typeof E_ARMS;

export interface QaRecord {
  qid: string;
  arm: EArmId;
  context: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  answer: string | null;
  prompt: string;
  stdoutFile: string;
  at: string;
  /** 答案经备式标记抽出（模型没按契约字面 `FINAL_ANSWER:` 收尾，见 pickFinalAnswer）。
   *  判分照常；留痕是对账用——放宽面有多大、有没有误取，qa-state 一眼可数。 */
  answerVia?: 'fallback';
  /** 无答案且 stdout 含 429/限额特征（额度窗耗尽嫌疑）——熔断与续跑（--skip-existing）判断用；判分侧忽略 */
  quotaHit?: boolean;
  /** 额度重置提示行原文（含重置时间；quota-run 据此定时续跑） */
  quotaLine?: string;
  /** 本题作答时库的行时刻态（--row-time；开关出现前的旧记录无此字段 = replay）——
   *  续跑一致性闸据此拒混态 */
  rowTime?: RowTimeMode;
}

/** 契约字面最终答案行：行中容忍（模型可不换行直书——「…记下来。FINAL_ANSWER: …」，
 *  冒烟实测），只锚行尾；占位示例 `<your answer>` 形态排除（指令回显不算答）。 */
const CONTRACT_LINE = /FINAL_ANSWER:(?!\s*<your answer>)\s*(.+?)[ \t]*$/gm;

/** 备式最终答案行：契约字面缺席时才认的等价标记，闭合两式——中文「最终答案」与英文
 *  `final answer` / `final_answer`（不分大小写，冒号全半角皆可）。**只认行首**（容忍
 *  列表符 / 粗体星号）：备式是兜底，宁漏不误取——行中的「…所以最终答案：」是推理
 *  正文。形状来源：实跑转录——模型改用中文作答时把收尾标记写成
 *  「最终答案：17 天」，契约字面缺席，只认契约字面的判法空等到超时、记无答。 */
const FALLBACK_LINE = /^[ \t>*_-]*(?:最终答案|final[ _]answer)[ \t]*[:：](?!\s*<your answer>)[ \t]*\**[ \t]*(.+?)[ \t]*\**[ \t]*$/gim;

/** 末次命中（模型复述格式行时以最后一次为准）。 */
function lastMatch(stdout: string, re: RegExp): string | null {
  const matches = [...stdout.matchAll(re)];
  return matches.length > 0 ? matches[matches.length - 1][1].trim() : null;
}

/** stdout → 最终答案 + 哪一式命中。契约字面在场取其末次命中、**不碰备式**——契约
 *  字面在场的回合，抽取结果与只有契约一式时逐字相同；契约字面缺席才看备式（同样
 *  末次命中）。收口门与落盘抽取共用本函数：门开即抽得出。 */
export function pickFinalAnswer(stdout: string): { answer: string | null; via: 'contract' | 'fallback' | null } {
  const contract = lastMatch(stdout, CONTRACT_LINE);
  if (contract !== null) return { answer: contract, via: 'contract' };
  const fallback = lastMatch(stdout, FALLBACK_LINE);
  return fallback !== null ? { answer: fallback, via: 'fallback' } : { answer: null, via: null };
}

/** 收口门：最终答案行已见（契约字面或备式标记，占位示例除外）且回合已收口——
 *  `你> ` 提示符再现 = 第 2 次（启动 1 次 + 答完 1 次）。用提示符计数门控而非
 *  见词即退：防模型在推理中引用格式措辞时提前截断回合。 */
export function turnClosed(stdout: string): boolean {
  return pickFinalAnswer(stdout).answer !== null && (stdout.match(/^你> /gm) ?? []).length >= 2;
}

/** stdout 里 ask_user 等待提示符（pipe 传输 ASK_PROMPT「答> 」）的出现次数——每现
 *  一次即一次在等答案，各喂一行 ASK_STEER_LINE（产品侧 ASK_USER_MAX 上限内收敛）。
 *  提示符为整行形态（可带尾随空格、流尾无换行也命中）；行中「答>」字样与 `你> `
 *  提示符均不计。 */
export function countAskPrompts(stdout: string): number {
  return (stdout.match(/^答> ?$/gm) ?? []).length;
}

/** ask_user 的固定应答行：pipe 形态没有真用户，把模型逼回记忆面直接作答。
 *  全臂全题同一行（介入面统一，臂间可比）。 */
export const ASK_STEER_LINE =
  '(No user follow-up available in this run. Answer using only memory and context; end with a final line FINAL_ANSWER: <your answer>)';

/** E 臂题面 = basePrompt 折单行（+ 臂附加行，见 E_ARMS）。pipe 传输一行一回合
 *  （PipeTransport deliver 逐行成 turn）——多行题面会被拆成多回合、后续行还会被
 *  ask_user 当答案截走（冒烟实测）；内容与 mem 侧四臂同源（basePrompt 折叠，
 *  仅空白形态差异）。 */
export function ePromptOneline(q: PackQuestion, suffix = ''): string {
  return basePrompt(q).split('\n').map(l => l.trim()).filter(Boolean).join(' ') + suffix;
}

/** 单题答题：spawn exo（pipe）→ 题面单行喂 stdin（**保持开**）→ 流式监听 stdout：
 *  「答> 」（ask_user 等答案，pipe ASK_PROMPT）→ 写 ASK_STEER_LINE 作答；最终答案行
 *  + `你> ` 再现（turnClosed）→ 写 quit + EOF 收口（quit 裸词回合 → onExit；EOF 后
 *  rlConfirm 即返，无确认读悬挂）。超时杀树兜底。 */
async function answerOne(
  q: PackQuestion,
  contextId: string,
  arm: EArmId,
  daemonPort: number,
  timeoutMs: number,
  stdoutFile: string,
  rowTime: RowTimeMode,
): Promise<QaRecord> {
  const prompt = ePromptOneline(q, E_ARMS[arm].promptSuffix);
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of ['LMG_DAEMON_PORT', 'LMG_MEM_BACKEND', 'LMG_MEM_API', 'LMG_MEM_TOKEN', 'LMG_MEM_PROJECT', 'LMG_MEM_CONTEXT', 'LMG_DEEP_RETRIEVAL', 'LMG_MEM_VERBATIM_TOPK']) {
    delete env[key];
  }
  Object.assign(env, {
    LMG_MEM_BACKEND: 'remote',
    LMG_DAEMON_PORT: String(daemonPort),
    LMG_MEM_CONTEXT: contextId, // 答题会话节点（不收尾：closeout 缺省关）
    // 产品缺省即答题形态：LMG_CLOSEOUT / LMG_VERBATIM 全不设（缺省关）；原文读面区宽
    // 剥壳后由臂 env 显式定值（default 32 = bench 校准宽，deep 0）——不吃缺省漂移
    LMG_TEE: '0', // 呈现 tee 关（stdout 自采，不落产品 logs/）
    LMG_CLOSE_WAIT_MS: String(timeoutMs), // EOF 后等在途 turn 的耐心对齐本驱动的杀树时限（缺省 60s 会先截断长回合）
    ...E_ARMS[arm].env,
  });
  const cmdArgs: string[] = [];
  if (existsSync(path.join(EXO_DIR, '.env'))) cmdArgs.push('--env-file=.env');
  cmdArgs.push('src/index.ts');
  const t0 = Date.now();
  return await new Promise<QaRecord>((resolve) => {
    const child = spawn(TSX, cmdArgs, { cwd: EXO_DIR, env, windowsHide: true, shell: true });
    let full = '';
    let settled = false;
    let timedOut = false;
    let done = false; // 最终答案已见（进入收口流程，不再应答 ask）
    let asksHandled = 0; // 已应答的 ask_user 次数（每问一答，不重复写）
    const onChunk = (d: Buffer) => {
      full += d;
      if (!done) {
        const asks = countAskPrompts(full);
        if (asks > asksHandled) {
          asksHandled = asks;
          try { child.stdin!.write(ASK_STEER_LINE + '\n'); } catch { /* 秒退时 EPIPE——close 自会收口 */ }
          return;
        }
        // 最终答案行已见且回合已收口 → quit（门与落盘抽取同一判法，见 turnClosed）
        if (turnClosed(full)) {
          done = true;
          try { child.stdin!.write('quit\n'); child.stdin!.end(); } catch { /* 同上 */ }
        }
      }
    };
    child.stdout.on('data', onChunk);
    child.stderr.on('data', onChunk);
    const timer = setTimeout(() => {
      timedOut = true; // 先置标记再杀树：close 事件晚于本回调，读到的即是已置位
      if (child.pid) spawn('taskkill', ['/PID', String(child.pid), '/T', '/F']);
    }, timeoutMs);
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      writeFileSync(stdoutFile, full, 'utf8');
      const picked = pickFinalAnswer(full);
      const answer = picked.answer;
      const quotaHit = answer === null && /429|限额/i.test(full);
      const quotaLine = quotaHit ? full.match(/您的限额将在[^\r\n]*/)?.[0] : undefined;
      resolve({
        qid: q.id, arm, context: contextId, exitCode, timedOut,
        durationMs: Date.now() - t0, answer,
        ...(picked.via === 'fallback' ? { answerVia: 'fallback' as const } : {}),
        prompt, stdoutFile: path.relative(benchRoot, stdoutFile), at: new Date().toISOString(),
        quotaHit: quotaHit || undefined,
        quotaLine,
        rowTime,
      });
    };
    child.on('close', finish);
    child.on('error', err => { full += String(err); finish(null); });
    // 题面单行；stdin 不 EOF（留着给 ask_user 应答与 quit 收口用）
    try {
      child.stdin!.write(prompt + '\n');
    } catch { /* 进程秒退时 write 可能 EPIPE——close/error 路径自会收口 */ }
  });
}

// ------------------------------------------------------------------ main

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const dataset = args.dataset === 'locomo' ? 'locomo' as const : 'lme' as const;
  const armId = (args.arm ?? 'default') as EArmId;
  const armDef = E_ARMS[armId];
  if (!armDef) throw new Error(`未知臂 ${args.arm}（default / deep）`);
  const tag = args.tag ? String(args.tag) : undefined;
  const jobs = Math.max(1, Number(args.jobs || 2));
  const limit = args.limit ? Number(args.limit) : undefined;
  const timeoutMs = Number(args['timeout-ms'] || 600_000);
  const skipExisting = !!args['skip-existing'];
  const rowTime = parseRowTimeMode(args['row-time']);

  const cfg = loadChainEnv(dataset);
  const clock = () => { const d = new Date(); const p2 = (n: number) => String(n).padStart(2, '0'); return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`; };
  const log = (msg: string) => console.log(`[chain-qa ${clock()}] ${msg}`);

  // —— 题面：frozen 清单 ∩ pack（lme 缺省清单 = frozen/lme-126.json；locomo 缺省全量）——
  const ds = loadPack(cfg.dataDir, dataset);
  const byId = new Map(ds.questions.map(q => [q.id, q]));
  const idList: string[] = args.ids
    ? (JSON.parse(readFileSync(args.ids, 'utf8')) as { questionIds?: string[] }).questionIds ?? []
    : dataset === 'lme'
      ? (JSON.parse(readFileSync(path.join(benchRoot, 'frozen', 'lme-126.json'), 'utf8')) as { questionIds: string[] }).questionIds ?? []
      : ds.questions.map(q => q.id);
  const picked = (limit ? idList.slice(0, limit) : idList).map(id => byId.get(id)!).filter(Boolean);
  if (picked.length === 0) throw new Error('题集为空（清单与数据池不交？）');
  log(`臂 ${armId}${tag ? `（tag=${tag}）` : ''}：${picked.length} 题（jobs=${jobs}，timeout=${Math.round(timeoutMs / 1000)}s）`);

  // —— 续跑一致性闸（纯读，先于一切副作用）：产物目录里已有记录的行时刻态须与本轮一致 ——
  const armDir = path.join(chainRunDir(cfg.stateDir, RUN_ID), tag ? `${armId}-${tag}` : armId);
  const stateFile = path.join(armDir, 'qa-state.json');
  if (existsSync(stateFile)) {
    assertRowTimeConsistent(JSON.parse(readFileSync(stateFile, 'utf8')) as Record<string, QaRecord>, rowTime);
  }

  // —— 健康门 ——
  const mem = new MemClient({ baseUrl: cfg.memUrl });
  const h = await mem.health();
  if (h.status !== 'UP') throw new Error(`链线 mem 实例 ${cfg.memUrl} 不健康——先起：shared\\scripts\\mem-bench-app.ps1 start -Dataset ${dataset} -Line lmg`);
  log(`mem ${cfg.memUrl} UP（outbox pending=${h.outboxPending}）`);

  // —— 行时刻态（--row-time）：租约 + 库补丁都在轮首轮尾（机制面见 lmg/row-time.ts）。
  //    放在起 daemon 之前——异态轮在场即拒跑，不动别人正在用的 daemon ——
  const rowTimeRun: RowTimeHandle = await beginRowTime({
    mode: rowTime,
    lease: await acquireRowTimeLease(cfg.dbName, {
      mode: rowTime, pid: process.pid, at: new Date().toISOString(), label: tag ? `${armId}-${tag}` : armId,
    }),
    store: psqlRowTimeStore(cfg.dbName),
    targets: planRowTime(picked, ds.conversations ?? []),
    log,
  });

  let exitCode = 0;
  try {
    // —— 答题 daemon（worker 关——三重控制之二）——
    await ensureChainDaemon(cfg.memUrl, cfg.daemonPort, { closeoutWorker: false }, log);
    // —— qa 会话节点预建（project 已在 formation 建；restore 后 qa 节点随快照态 absent）——
    for (const q of picked) {
      const project = benchProjectId(dataset, q.id);
      await mem.ensureChildContext(qaSession(project, armId), project, 'session', `qa-${armId}`);
    }
    mkdirSync(armDir, { recursive: true });
    const state: Record<string, QaRecord> = existsSync(stateFile)
      ? JSON.parse(readFileSync(stateFile, 'utf8')) as Record<string, QaRecord>
      : {};
    const saveState = () => writeFileSync(stateFile, JSON.stringify(state, null, 1), 'utf8');

    let next = 0;
    let answered = 0;
    let failed = 0;
    // 额度窗熔断：连续多题无答案且带 429/限额特征（LLM 5h 窗/周额度耗尽）时提前中止——
    // 不熔断每题都要空等满超时（600s×N）；qa-state 已保答案，重置后 --skip-existing 续跑。
    let quotaStreak = 0;
    let quotaAbort = false;
    const worker = async () => {
      for (;;) {
        const i = next++;
        if (i >= picked.length || quotaAbort) return;
        const q = picked[i];
        if (skipExisting && state[q.id]?.answer) continue;
        const project = benchProjectId(dataset, q.id);
        const stdoutFile = path.join(armDir, `${q.id}.stdout.txt`);
        const rec = await answerOne(q, qaSession(project, armId), armId, cfg.daemonPort, timeoutMs, stdoutFile, rowTime);
        state[q.id] = rec;
        saveState();
        answered++;
        if (rec.answer === null) {
          failed++;
          log(`NO-ANSWER ${q.id}（exit=${rec.exitCode} ${rec.timedOut ? 'timeout' : ''} ${Math.round(rec.durationMs / 1000)}s）——看 ${path.basename(stdoutFile)}${rec.quotaHit ? ' 【QUOTA-HIT】' : ''}`);
          if (rec.quotaLine) log(`QUOTA ${rec.quotaLine}`);
          if (rec.quotaHit) {
            quotaStreak++;
            if (quotaStreak >= 6 && !quotaAbort) {
              quotaAbort = true;
              log(`连续 ${quotaStreak} 题撞额度特征（429/限额）——提前中止本轮；已有答案在 qa-state，重置后 --skip-existing 续跑（quota-run 包装自动接）`);
            }
          } else {
            quotaStreak = 0;
          }
        } else {
          quotaStreak = 0;
          if (answered % 10 === 0) {
            log(`进度 ${answered}/${picked.length}（no-answer ${failed}）`);
          }
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(jobs, picked.length) }, worker));
    if (quotaAbort) {
      log(`额度窗中断：answered ${answered} / no-answer ${failed}——重置后同命令（加 --skip-existing）续跑`);
      exitCode = 1;
    } else {
      // 完整跑 = 退出 0：no-answer（超时/进程死）是单列终态结果（判分面照常判其余题），
      // 不是流程失败——混进退出码 1 会被 quota-run 当真错误透传中止链。
      log(`答题完成：${answered} 题 / no-answer ${failed}（单列终态，不阻判分；状态树 ${path.relative(benchRoot, stateFile)}）`);
      exitCode = 0;
    }
  } finally {
    if (!(await shutdownChainDaemon(cfg.daemonPort))) {
      log(`警告：daemon :${cfg.daemonPort} 未停掉——手动 POST /shutdown`);
      exitCode = exitCode || 2;
    } else {
      log('daemon 已停');
    }
    // 行时刻收尾（source：还原库 / replay：只撤租约）——必须发生在 daemon 停后：
    // 还原完才轮得到下一轮干净开局
    try {
      await rowTimeRun.end();
    } catch (err) {
      log(`警告：行时刻收尾未完成——${(err as Error).message}；库可能停在 source 态（下一轮 replay 会自动还原，或 npx tsx lmg/row-time.ts status 手工核）`);
      exitCode = exitCode || 2;
    }
  }
  process.exit(exitCode);
}

if (!process.env.VITEST) {
  main().catch(err => {
    console.error(String((err as Error).stack ?? err));
    process.exit(1);
  });
}
