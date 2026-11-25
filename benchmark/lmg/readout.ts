/**
 * lmg 链答题读数——qa-state + 判分产物 → 人读 md（一屏总览）。
 * 用法：npx tsx lmg/readout.ts --arm=default [--dataset=lme]
 * 前置：该臂 qa 跑完；judge-qa 跑过则带判分读数（judge.json / judge-official.json
 *       缺席时判分列标「未判」，状态与抽取面照报）。
 * 产物：<armDir>/readout.md（chain/qa/<arm>/ 下）。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from '../shared/args.ts';
import { loadChainEnv } from '../shared/config.ts';
import { loadPack } from '../shared/pack.ts';
import { chainRunDir } from '../shared/coords.ts';
import type { QaRecord } from './qa.ts';

interface V2JudgeRow {
  qid: string;
  category: string;
  verdict: 'correct' | 'wrong' | null;
  pred: string | null;
  gold: string;
  reason?: string;
}
interface OfficialJudgeRow {
  qid: string;
  category: string;
  verdict: 'correct' | 'wrong' | null;
  pred: string | null;
  gold: string;
}
interface JudgeSummary {
  judged: number;
  correct: number;
  skipped: number;
}
interface JudgeFile {
  kind: 'judge';
  judgeModel: string;
  promptVersion: string;
  summary: JudgeSummary & { judgeAcc: number | null };
  results: V2JudgeRow[];
}
interface OfficialJudgeFile {
  judgeModel: string;
  summary: JudgeSummary & { officialAcc: number | null; crossTrack: { paired: number; agree: number; flipUp: number; flipDown: number } };
  results: OfficialJudgeRow[];
}

function trunc(s: string | null, n: number): string {
  if (s === null) return '—';
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n - 1) + '…' : one || '（空）';
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const dataset: 'lme' = 'lme';
  const armId = args.arm ?? 'default';
  const tag = args.tag ? String(args.tag) : undefined;
  const cfg = loadChainEnv(dataset);
  const armDir = path.join(chainRunDir(cfg.stateDir, 'qa'), tag ? `${armId}-${tag}` : armId);
  const stateFile = path.join(armDir, 'qa-state.json');
  if (!existsSync(stateFile)) throw new Error(`缺 ${stateFile}——先跑 lmg/qa.ts --arm=${armId}`);

  const recs = JSON.parse(readFileSync(stateFile, 'utf8')) as Record<string, QaRecord>;
  const entries = Object.entries(recs);
  const ds = loadPack(cfg.dataDir, dataset);
  const catById = new Map(ds.questions.map(q => [q.id, q.categoryLabel]));

  const judgeFile = path.join(armDir, 'judge.json');
  const offFile = path.join(armDir, 'judge-official.json');
  const judged = existsSync(judgeFile) ? JSON.parse(readFileSync(judgeFile, 'utf8')) as JudgeFile : null;
  const judgedOff = existsSync(offFile) ? JSON.parse(readFileSync(offFile, 'utf8')) as OfficialJudgeFile : null;
  const offByQid = judgedOff ? new Map(judgedOff.results.map(r => [r.qid, r])) : null;
  const v2ByQid = judged ? new Map(judged.results.map(r => [r.qid, r])) : null;

  const lines: string[] = [];
  lines.push(`# readout — ${tag ? `${armId}-${tag}` : armId}（${dataset}）`);
  lines.push('');
  const durations = entries.map(([, r]) => r.durationMs);
  lines.push(`- 题数：${entries.length}（题面契约 = shared/prompt.ts，全部 FINAL_ANSWER 契约折单行喂 pipe）`);
  lines.push(`- 状态：ok ${entries.filter(([, r]) => r.answer !== null).length} / timeout ${entries.filter(([, r]) => r.answer === null && r.timedOut).length} / error ${entries.filter(([, r]) => r.answer === null && !r.timedOut).length}`);
  lines.push(`- 备式标记答案（answerVia=fallback）：${entries.filter(([, r]) => r.answerVia === 'fallback').length}`);
  lines.push(`- 额度命中（quotaHit）：${entries.filter(([, r]) => r.quotaHit).length}`);
  if (durations.length > 0) {
    const mean = durations.reduce((a, b) => a + b, 0) / durations.length;
    lines.push(`- 单题耗时：均值 ${(mean / 1000).toFixed(0)}s / 最大 ${(Math.max(...durations) / 1000).toFixed(0)}s`);
  }
  lines.push('');

  // —— 判分读数（官方轨为主口径——LongMemEval 对标可比）——
  if (judgedOff) {
    const s = judgedOff.summary;
    lines.push(`## 官方轨判分（judge=${judgedOff.judgeModel}）`);
    lines.push('');
    lines.push(`- 判 ${s.judged} / 对 ${s.correct} → **${s.officialAcc === null ? '—' : (s.officialAcc * 100).toFixed(1) + '%'}**（未判单列 ${s.skipped}）`);
    const ct = s.crossTrack;
    lines.push(`- 双轨对照：paired=${ct.paired} agree=${ct.agree}（flipUp=${ct.flipUp} flipDown=${ct.flipDown}）`);
    lines.push('');
    const byCat = new Map<string, { n: number; ok: number }>();
    for (const r of judgedOff.results) {
      if (r.verdict === null) continue;
      const b = byCat.get(r.category) ?? { n: 0, ok: 0 };
      b.n++;
      if (r.verdict === 'correct') b.ok++;
      byCat.set(r.category, b);
    }
    lines.push('| 题型 | 已判 | 对 | 正确率 |');
    lines.push('|---|---|---|---|');
    for (const [cat, b] of [...byCat.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      lines.push(`| ${cat} | ${b.n} | ${b.ok} | ${((b.ok / b.n) * 100).toFixed(1)}% |`);
    }
    lines.push('');
    const wrong = judgedOff.results.filter(r => r.verdict === 'wrong');
    if (wrong.length > 0) {
      lines.push(`## 错题（官方轨，${wrong.length} 题）`);
      lines.push('');
      lines.push('| qid | 题型 | 预测 | 金标 |');
      lines.push('|---|---|---|---|');
      for (const r of wrong) lines.push(`| ${r.qid} | ${r.category} | ${trunc(r.pred, 60)} | ${trunc(r.gold, 60)} |`);
      lines.push('');
    }
  } else {
    lines.push('## 判分：未跑（npx tsx lmg/judge-qa.ts --arm=<arm> 后重渲染）');
    lines.push('');
  }

  // —— 语义轨摘要 + 未判题清单 ——
  if (judged) {
    const s = judged.summary;
    lines.push(`## 语义轨判分（judge=${judged.judgeModel}，${judged.promptVersion}）`);
    lines.push('');
    lines.push(`- 判 ${s.judged} / 对 ${s.correct} → ${s.judgeAcc === null ? '—' : (s.judgeAcc * 100).toFixed(1) + '%'}（未判单列 ${s.skipped}）`);
    lines.push('');
  }
  const unanswered = entries.filter(([, r]) => r.answer === null);
  if (unanswered.length > 0) {
    lines.push(`## 无答案题（${unanswered.length} 题）`);
    lines.push('');
    lines.push('| qid | 状态 | 退出码 | 耗时s |');
    lines.push('|---|---|---|---|');
    for (const [qid, r] of unanswered) {
      lines.push(`| ${qid} | ${r.timedOut ? 'timeout' : 'error'} | ${r.exitCode ?? '—'} | ${(r.durationMs / 1000).toFixed(0)} |`);
    }
    lines.push('');
  }

  // —— 逐题速览（官方轨 verdict 优先，无判分则机械空）——
  lines.push('## 逐题速览');
  lines.push('');
  lines.push('| qid | 题型 | 状态 | 官方轨 | 预测 | 金标 |');
  lines.push('|---|---|---|---|---|---|');
  for (const [qid, r] of entries) {
    const off = offByQid?.get(qid);
    const verdict = off ? (off.verdict === 'correct' ? '✓' : off.verdict === 'wrong' ? '✗' : '—') : '未判';
    const status = r.answer !== null ? 'ok' : r.timedOut ? 'timeout' : 'error';
    lines.push(`| ${qid} | ${catById.get(qid) ?? '?'} | ${status} | ${verdict} | ${trunc(r.answer, 48)} | ${trunc(off?.gold ?? null, 48)} |`);
  }
  lines.push('');

  const outFile = path.join(armDir, 'readout.md');
  writeFileSync(outFile, lines.join('\n'), 'utf8');
  console.log(`readout → ${outFile}`);
}

main();
