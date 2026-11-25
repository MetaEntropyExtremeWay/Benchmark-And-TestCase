/**
 * lmg 链答题判分——语义轨 + 官方轨双轨，一次跑两份。
 *
 * 判分口径单源 shared/judge-core.ts（同提示词同版本）+ shared/judge-official-core.ts
 * （官方 LongMemEval 模板同判读）；本件 = 记录形状适配 + 双轨驱动——答题产物是
 * chain/qa/<arm>/qa-state.json（QaRecord）。分母纪律两轨一致：超时/进程死（无答案）
 * 不判单列，弃权机械判错。
 *
 * 映射：answer 在场 = ok（timedOut 但已抽到答案也判——答案有效）；answer 缺
 * + timedOut = timeout（流程问题不判）；answer 缺 + 未超时 = error（进程死不判）。
 * 金标/题型取数据集面（题集 pack，qid 必须全命中——fail fast）。
 *
 * 用法（benchmark 根）：
 *   npx tsx lmg/judge-qa.ts --dataset=lme --arm=default [--jobs=4] [--limit=N]
 * 产物（arm 目录 output/<ds>/chain/qa/<arm>/）：
 *   judge.json（语义轨）+ judge-official.json（官方轨 + 双轨对照）+
 *   judge-sample.md（人读过目面，双轨并列）。
 * 幂等：重跑覆盖写（离线重判零答题成本）。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from '../shared/args.ts';
import { loadChainEnv, benchVar } from '../shared/config.ts';
import { loadPack, type PackQuestion } from '../shared/pack.ts';
import { getAdapter } from '../datasets/registry.ts';
import { chat, parseJsonLoose } from '../shared/llm.ts';
import { f1Score } from '../shared/score.ts';
import { chainRunDir } from '../shared/coords.ts';
import { JUDGE_SYSTEM, JUDGE_PROMPT_VERSION, judgeUser, normalizeVerdict, F1_MATCH_THRESHOLD } from '../shared/judge-core.ts';
import { officialPrompt, isAbstention, officialLabel, OFFICIAL_SYSTEM, OFFICIAL_PROMPT_VERSION } from '../shared/judge-official-core.ts';
import type { QaRecord, EArmId } from './qa.ts';

/** QaRecord → 判分输入（status 口径与 HostRecord 对齐：ok 进判分，其余单列）。 */
export interface QaJudgeInput {
  qid: string;
  status: 'ok' | 'timeout' | 'error';
  pred: string | null;
}

export function qaRecordToInput(rec: QaRecord): QaJudgeInput {
  if (rec.answer !== null) return { qid: rec.qid, status: 'ok', pred: rec.answer };
  // 无答案：超时杀树 = timeout；非超时无答案 = 进程死/error（都不判，单列流程问题）
  return { qid: rec.qid, status: rec.timedOut ? 'timeout' : 'error', pred: null };
}

interface V2Result {
  qid: string;
  category: string;
  status: string;
  judged: boolean;
  verdict: 'correct' | 'wrong' | null;
  reason: string;
  f1: number | null;
  f1Match: boolean | null;
  disagree: boolean | null;
  pred: string | null;
  gold: string | null;
  error?: string;
}

interface OfficialResult {
  qid: string;
  category: string;
  verdict: 'correct' | 'wrong' | null;
  judgeRaw: string;
  pred: string | null;
  gold: string | null;
  error?: string;
}

async function main(): Promise<void> {
  const argv = parseArgs(process.argv.slice(2));
  const armId = argv.arm as EArmId;
  if (!armId) throw new Error('用法：npx tsx lmg/judge-qa.ts --dataset=lme --arm=default [--jobs=4] [--limit=N]');
  const dataset = argv.dataset === 'locomo' ? 'locomo' as const : 'lme' as const;
  // 官方轨 = LongMemEval 官方模板口径；数据集是否适用由 adapter 声明（judgeTracks）。
  const officialTrack = getAdapter(dataset).judgeTracks.includes('official');
  const cfg = loadChainEnv(dataset);

  const baseUrl = benchVar('BENCH_LLM_BASE_URL', '');
  const apiKey = benchVar('BENCH_LLM_API_KEY', '');
  const model = benchVar('BENCH_JUDGE_MODEL', 'glm-5.3');
  const timeoutMs = Number(benchVar('BENCH_LLM_TIMEOUT_MS', '120000')) || 120_000;
  if (!baseUrl || !apiKey) throw new Error('缺 BENCH_LLM_BASE_URL / BENCH_LLM_API_KEY（benchmark/.env）');

  const armDir = path.join(chainRunDir(cfg.stateDir, 'qa'), armId);
  const recs = (JSON.parse(readFileSync(path.join(armDir, 'qa-state.json'), 'utf8')) as Record<string, QaRecord>);
  const keys = Object.keys(recs);
  const limit = argv.limit ? Math.max(1, Number(argv.limit) || 1) : undefined;
  const sel = limit ? keys.slice(0, limit) : keys;

  const loaded = loadPack(cfg.dataDir, dataset);
  const qMap = new Map(loaded.questions.map(q => [q.id, q]));
  const missing = sel.filter(k => !qMap.has(k));
  if (missing.length > 0) throw new Error(`qa-state 有 ${missing.length} 个 qid 不在数据集 pack 内（前 3：${missing.slice(0, 3).join(', ')}）`);

  const judgeOne = async (key: string): Promise<{ v2: V2Result; off: OfficialResult }> => {
    const rec = recs[key];
    const input = qaRecordToInput(rec);
    const q = qMap.get(key)!;
    const category = q.categoryLabel ?? '?';
    const gold = q.goldAnswer ?? null;
    if (gold === null) throw new Error(`${key} 金标缺失——LME 不该出现（数据集面问题，fail fast）`);
    const goldLabel = String(gold);

    if (input.status !== 'ok') {
      const reason = `run 状态 ${input.status}（${input.status === 'timeout' ? '超时杀树' : '进程死/无收口'}），不判（单列流程问题）`;
      return {
        v2: { qid: key, category, status: input.status, judged: false, verdict: null, reason, f1: null, f1Match: null, disagree: null, pred: null, gold: goldLabel },
        off: { qid: key, category, verdict: null, judgeRaw: '', pred: null, gold: goldLabel, error: reason },
      };
    }
    const pred = input.pred as string;

    // —— v2 语义轨（judge-core 同提示词同版本）——
    let v2r: V2Result | null = null;
    let v2Err: string | undefined;
    const userBase = judgeUser(q.question, goldLabel, pred);
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const res = await chat({
          baseUrl, apiKey, model,
          system: JUDGE_SYSTEM,
          user: attempt === 1
            ? userBase
            : `${userBase}\n\n（上一次输出不是合法 JSON 或 verdict 认不出——这次只输出一行 JSON，形如 {"verdict":"correct","reason":"一句话理由"}，不要输出任何其他文字。）`,
          timeoutMs, maxTokens: 512,
        });
        const out = parseJsonLoose(res.content) as { verdict?: unknown; reason?: unknown };
        const verdict = normalizeVerdict(out.verdict);
        const reason = typeof out.reason === 'string' ? out.reason : String(out.reason ?? '');
        if (verdict !== null) {
          const f1 = f1Score(pred, goldLabel);
          const f1Match = f1 >= F1_MATCH_THRESHOLD;
          v2r = {
            qid: key, category, status: 'ok', judged: true, verdict, reason, f1, f1Match,
            disagree: verdict === 'correct' !== f1Match, pred, gold: goldLabel,
          };
          break;
        }
        v2Err = `judge 输出 verdict 认不出：${String(out.verdict)}`;
      } catch (e) {
        v2Err = String(e);
      }
    }
    if (!v2r) {
      const f1 = f1Score(pred, goldLabel);
      v2r = { qid: key, category, status: 'ok', judged: false, verdict: null, reason: `未判：${v2Err ?? ''}`, f1, f1Match: f1 >= F1_MATCH_THRESHOLD, disagree: null, pred, gold: goldLabel, error: v2Err };
    }

    // —— 官方轨（模板 + contains-yes 判读，同 judge-official）；非 lme 数据集单列未判 ——
    let off: OfficialResult;
    if (!officialTrack) {
      off = { qid: key, category, verdict: null, judgeRaw: '', pred, gold: goldLabel, error: '官方轨仅 lme 数据集（LongMemEval 官方模板口径）' };
      return { v2: v2r, off };
    }
    const abstention = isAbstention(key, category);
    const prompt = officialPrompt(category, q.question, goldLabel, pred, abstention);
    let resp = '';
    let offErr: string | undefined;
    try {
      const r = await chat({ baseUrl, apiKey, model, system: OFFICIAL_SYSTEM, user: prompt, timeoutMs, maxTokens: 512 });
      resp = r.content;
    } catch (e) {
      offErr = String(e);
    }
    if (!offErr && resp.trim().length === 0) {
      try {
        const r = await chat({ baseUrl, apiKey, model, system: OFFICIAL_SYSTEM, user: prompt, timeoutMs, maxTokens: 512 });
        resp = r.content;
      } catch (e) {
        offErr = String(e);
      }
    }
    off = offErr
      ? { qid: key, category, verdict: null, judgeRaw: resp.slice(0, 80), pred, gold: goldLabel, error: offErr }
      : { qid: key, category, verdict: officialLabel(resp) ? 'correct' : 'wrong', judgeRaw: resp.slice(0, 80), pred, gold: goldLabel };

    return { v2: v2r, off };
  };

  const jobs = Math.min(Math.max(Number(argv.jobs ?? 4) || 4, 1), 8);
  const v2Results: V2Result[] = new Array(sel.length);
  const offResults: OfficialResult[] = new Array(sel.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < sel.length) {
      const i = cursor++;
      const { v2, off } = await judgeOne(sel[i]);
      v2Results[i] = v2;
      offResults[i] = off;
      console.log(`[${sel[i]}] v2=${v2.verdict ?? '未判'}（f1=${v2.f1 === null ? '—' : v2.f1.toFixed(2)}）官方=${off.verdict ?? '未判'}${v2.reason ? ` ${v2.reason.slice(0, 60)}` : ''}`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(jobs, sel.length) }, worker));

  // —— 语义轨汇总 ——
  const judged = v2Results.filter(r => r.verdict !== null);
  const correct = judged.filter(r => r.verdict === 'correct').length;
  const f1Track = v2Results.filter(r => r.f1Match !== null);
  const f1Ok = f1Track.filter(r => r.f1Match).length;
  const disagree = v2Results.filter(r => r.disagree === true);
  const runId = `chain/qa/${armId}`;
  const judgedAt = new Date().toISOString();

  writeFileSync(path.join(armDir, 'judge.json'), JSON.stringify({
    kind: 'judge' as const, runId, judgedAt, judgeModel: model,
    promptVersion: JUDGE_PROMPT_VERSION, f1Threshold: F1_MATCH_THRESHOLD,
    summary: {
      judged: judged.length, correct,
      judgeAcc: judged.length > 0 ? correct / judged.length : null,
      f1Track: f1Track.length, f1Ok, disagree: disagree.length,
      skipped: v2Results.length - judged.length,
    },
    results: v2Results,
  }, null, 2), 'utf-8');

  // —— 官方轨汇总 + 双轨对照 ——
  const offJudged = offResults.filter(r => r.verdict !== null);
  const offCorrect = offJudged.filter(r => r.verdict === 'correct').length;
  const v2Map = new Map(v2Results.map(r => [r.qid, r.verdict]));
  let agree = 0, flipUp = 0, flipDown = 0, paired = 0;
  for (const r of offJudged) {
    const v = v2Map.get(r.qid);
    if (v === undefined || v === null) continue;
    paired++;
    if (v === r.verdict) agree++;
    else if (v === 'wrong' && r.verdict === 'correct') flipUp++;
    else flipDown++;
  }
  writeFileSync(path.join(armDir, 'judge-official.json'), JSON.stringify({
    kind: 'judge-official' as const, runId, judgedAt, judgeModel: model,
    promptVersion: OFFICIAL_PROMPT_VERSION,
    summary: {
      judged: offJudged.length, correct: offCorrect,
      officialAcc: offJudged.length > 0 ? offCorrect / offJudged.length : null,
      crossTrack: { paired, agree, flipUp, flipDown },
      skipped: offResults.length - offJudged.length,
    },
    results: offResults,
  }, null, 2), 'utf-8');

  // —— 人读过目面：双轨并列样例表 ——
  const clip = (s: string, n: number): string => s.replace(/\r?\n/g, ' ').slice(0, n) + (s.length > n ? '…' : '');
  const cell = (s: string): string => s.replace(/\|/g, '／');
  const st: string[] = [];
  st.push(`# judge 样例 — ${runId}（judge ${model} / v2 ${JUDGE_PROMPT_VERSION} + 官方 ${OFFICIAL_PROMPT_VERSION} / ${new Date().toISOString().slice(0, 10)}）`);
  st.push('');
  st.push(`> 双轨 = 语义轨（rubric 盲三元组 + F1 对照）+ LongMemEval 官方轨（分题型宽容模板，contains-yes）；**对外引用以官方轨为主口径**（见 docs/protocol.md「判分」），语义轨为严格对照口径、读数不可与官方轨直比。金标列「（未提及）」= 弃权题（判分豁免）。`);
  st.push('');
  st.push(`| qid | 题面要点 | 预测 | 金标 | v2 | F1 | 官方 |`);
  st.push(`|---|---|---|---|---|---|---|`);
  for (let i = 0; i < sel.length; i++) {
    const r = v2Results[i];
    const o = offResults[i];
    const v = r.verdict === 'correct' ? '✓ 对' : r.verdict === 'wrong' ? '✗ 错' : '— 未判';
    const ov = o.verdict === 'correct' ? '✓ 对' : o.verdict === 'wrong' ? '✗ 错' : '— 未判';
    st.push(`| ${r.qid} | ${cell(clip(qMap.get(r.qid)?.question ?? '(题面缺失)', 60))} | ${cell(clip(r.pred ?? '（弃权）', 80))} | ${cell(clip(r.gold ?? '—', 60))} | ${v} | ${r.f1 === null ? '—' : r.f1.toFixed(2)} | ${ov} |`);
  }
  st.push('');
  st.push(`**汇总：** v2 ${correct}/${judged.length}；F1 轨 ${f1Ok}/${f1Track.length}；官方 ${offCorrect}/${offJudged.length}（双轨配对 ${paired}：一致 ${agree} / 官方宽 v2 严 ${flipUp} / v2 宽官方严 ${flipDown}）；未判 ${v2Results.length - judged.length}。`);
  writeFileSync(path.join(armDir, 'judge-sample.md'), st.join('\n') + '\n', 'utf-8');

  console.log(`\n${runId} 判分：v2 ${correct}/${judged.length}；官方 ${offCorrect}/${offJudged.length}；F1 轨 ${f1Ok}/${f1Track.length}（jobs=${jobs}）`);
  console.log(`judge.json / judge-official.json / judge-sample.md → ${armDir}`);

  // 未判非零退出（判分幂等覆盖写；额度窗中断最常见——quota-run 按退出码 + 「未判」特征自动重跑）。
  // 只数「答案在场但未判」＝额度/判分失败（可重试补齐）；超时/进程死题 answer 本就缺席，
  // 属单列终态——数上它们会让 quota-run 为永远判不了的题空转重试。
  const unjudged = v2Results.filter(r => r.status === 'ok' && !r.judged).length
    + offResults.filter(r => r.pred !== null && r.verdict === null).length;
  if (unjudged > 0) {
    console.error(`[judge-qa] ${unjudged} 题判分失败（答案在场未判——额度窗中断嫌疑）——退出码 5；额度恢复后重跑同命令即补齐`);
    process.exit(5);
  }
}

if (!process.env.VITEST) {
  main().catch(err => {
    console.error(String((err as Error).stack ?? err));
    process.exit(1);
  });
}
