/**
 * harness recall：检索直测——金标证据级 recall 独立读数（不藏在答题归因里）。
 * 用法：npx tsx mc/recall.ts --run=<runId> [--dataset lme|locomo] [--ks=5,10,16,32] [--topk=32]
 *       [--min-score=0.05] [--min-matched=2]
 * 协议：每题用**题面原句**探针（无模型参与、reinforce=false 不污染排序、
 *       min_score=0 拿门槛前候选——evidence/matched 随行带出），
 *       本地按 rank 前缀算会话级 recall@k，并按真实准入门槛（证据分 ≥ minScore
 *       或 词项命中 ≥ minMatched）复算门槛后对照轨。
 * 依赖：同 runId 的 prepare.json（contextId 坐标）——直测不依赖答题产物，
 *       prepare 完即可测；lmg 产品链答题面另有检索工具的模型侧消费读数（lmg/ 链），两轨互补。
 * 产物：recall.json（结构化，data/）+ recall.md（人读表，run 根）。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { loadPack } from '../shared/pack.ts';
import { getAdapter } from '../datasets/registry.ts';
import { MemClient } from '../shared/mem.ts';
import { loadHarnessEnv } from '../shared/config.ts';
import { parseArgs } from '../shared/args.ts';
import type { ProbeRow } from './recall-core.ts';
import { gatedRows, recallAtK, firstGoldRank } from './recall-core.ts';

interface PrepareManifestQ {
  qid: string;
  contextId: string;
}

interface PrepareManifest {
  kind: 'prepare';
  runId: string;
  dataset: 'lme' | 'locomo';
  limit: number | null;
  memUrl: string;
  questions: PrepareManifestQ[];
}

interface RecallQuestion {
  qid: string;
  category: string;
  goldN: number;
  /** ranked 探针带回的行数（门槛前）与过门槛行数 */
  hits: number;
  hitsGated: number;
  firstGoldRank: number | null;
  firstGoldRankGated: number | null;
  recallRaw: Record<string, number>;
  recallGated: Record<string, number>;
  /** 全序列（topk 上限内）recall——与 @32 的差 = topk 预算外的金标 */
  recallFull: number;
  /** 门槛后全序列 recall——归因第②类（召回被准入阈值切）的判据：full>0 而 gatedFull 缺 */
  recallGatedFull: number;
  /** 该题灌库 scope 域大小（prepare 同口径）与域内非金标干扰单元数（正常读数：底座噪声进 top-k） */
  scopeN: number;
  noiseUnits: number;
  /** 真越界：题域外单元键（跨题泄漏——非空 = 隔离失效，须停查 context 坐标） */
  outOfScope: string[];
  degraded: boolean;
}

async function main(): Promise<void> {
  const argv = parseArgs(process.argv.slice(2));
  const runId = argv.run;
  if (!runId) throw new Error('用法：npx tsx mc/recall.ts --run=<runId> [--dataset lme|locomo]');

  const ks = (argv.ks ?? '5,10,16,32').split(',').map(s => Number(s.trim())).filter(n => n > 0);
  const topk = Math.min(Number(argv.topk ?? 32) || 32, 32); // 服务端 topk-max=32
  const minScore = Number(argv['min-score'] ?? 0.05);
  const minMatched = Number(argv['min-matched'] ?? 2);

  const dataset = argv.dataset === 'locomo' ? 'locomo' as const : 'lme' as const;
  const env = loadHarnessEnv(dataset);
  const runRoot = path.join(env.stateDir, runId);
  const runDir = path.join(runRoot, 'data'); // 机器面
  const prepFile = path.join(runDir, 'prepare.json');
  if (!existsSync(prepFile)) {
    throw new Error(`缺 ${prepFile}——检索直测读 prepare 坐标（contextId），先 prepare 同 runId（--dataset ${dataset}）`);
  }
  const prep = JSON.parse(readFileSync(prepFile, 'utf8')) as PrepareManifest;
  if (prep.dataset !== dataset) throw new Error(`prepare.json dataset=${prep.dataset} 与 --dataset ${dataset} 不一致（run 树装错了域？）`);
  const adapter = getAdapter(prep.dataset);

  const pack = loadPack(env.dataDir, prep.dataset);
  const qMap = new Map(pack.questions.map(q => [q.id, q]));

  const client = new MemClient({ baseUrl: env.memUrl });
  console.log(
    `recall ${runId}：${prep.dataset} ${prep.questions.length} 题，题面原句探针 topk=${topk} min_score=0，` +
    `门槛本地复算（evidence ≥ ${minScore} 或 matched ≥ ${minMatched}）`,
  );

  const results: RecallQuestion[] = [];
  for (const p of prep.questions) {
    const q = qMap.get(p.qid);
    const gold = new Set(q?.goldKeys ?? []);
    if (gold.size === 0) console.warn(`  [${p.qid}] 金标单元为空（数据集异常），该题 recall 恒 0`);
    // 越界对照 = 该题完整 scope 域（prepare 串台验收同口径），不是金标集——
    // 域内非金标单元是底座干扰（正常读数），只有域外单元键才是跨题泄漏
    const scope = new Set(q?.scopeKeys ?? []);

    const { hits, degraded } = await client.search(q?.question ?? p.qid, p.contextId, topk, {
      reinforce: false,
      minScore: 0,
    });
    const rows: ProbeRow[] = hits.map(h => ({
      name: h.name,
      unit: adapter.hitKey(h),
      evidence: typeof h.evidence === 'number' ? h.evidence : null,
      matched: typeof h.matched === 'number' ? h.matched : null,
    }));
    const missingUnit = rows.filter(r => r.unit === '').length;
    if (missingUnit > 0) console.warn(`  [${p.qid}] ${missingUnit} 行 meta 缺计分键（按 miss 计）`);
    const distUnits = [...new Set(rows.map(r => r.unit).filter(u => u !== ''))];
    const outOfScope = distUnits.filter(u => !scope.has(u));
    const noiseUnits = distUnits.filter(u => scope.has(u) && !gold.has(u)).length;

    const gated = gatedRows(rows, minScore, minMatched);
    const keysRaw = rows.map(r => r.unit);
    const keysGated = gated.map(r => r.unit);
    const recallRaw: Record<string, number> = {};
    const recallGated: Record<string, number> = {};
    for (const k of ks) {
      recallRaw[String(k)] = recallAtK(keysRaw, gold, k);
      recallGated[String(k)] = recallAtK(keysGated, gold, k);
    }
    results.push({
      qid: p.qid,
      category: q?.categoryLabel ?? '?',
      goldN: gold.size,
      hits: rows.length,
      hitsGated: gated.length,
      firstGoldRank: firstGoldRank(keysRaw, gold),
      firstGoldRankGated: firstGoldRank(keysGated, gold),
      recallRaw,
      recallGated,
      recallFull: recallAtK(keysRaw, gold, keysRaw.length),
      recallGatedFull: recallAtK(keysGated, gold, keysGated.length),
      scopeN: scope.size,
      noiseUnits,
      outOfScope,
      degraded,
    });
    console.log(
      `  [${p.qid}] gold=${gold.size} 首中rank=${results[results.length - 1].firstGoldRank ?? '无'}` +
      ` recall@${ks.join('/')} raw=${ks.map(k => recallRaw[String(k)].toFixed(2)).join('/')}` +
      ` gated=${ks.map(k => recallGated[String(k)].toFixed(2)).join('/')}` +
      (degraded ? '（⚠ 检索降级）' : ''),
    );
  }

  const meanK = (track: 'recallRaw' | 'recallGated', k: number): number =>
    results.length > 0 ? results.reduce((s, r) => s + r[track][String(k)], 0) / results.length : 0;

  const doc = {
    kind: 'recall' as const,
    runId,
    probedAt: new Date().toISOString(),
    memUrl: env.memUrl,
    queryProtocol: 'question-verbatim（每题一查，无模型参与）',
    topk,
    ks,
    gate: { minScore, minMatched },
    summary: {
      questions: results.length,
      meanRecallRaw: Object.fromEntries(ks.map(k => [k, meanK('recallRaw', k)])),
      meanRecallGated: Object.fromEntries(ks.map(k => [k, meanK('recallGated', k)])),
      meanRecallFull: results.length > 0 ? results.reduce((s, r) => s + r.recallFull, 0) / results.length : 0,
    },
    results,
  };
  writeFileSync(path.join(runDir, 'recall.json'), JSON.stringify(doc, null, 2), 'utf8'); // 机器面：data/

  // 人读表：协议与门槛参数落档（读数可复现），逐题阶梯 + 均值行
  const pct = (n: number): string => n.toFixed(2);
  const md: string[] = [];
  md.push(`# recall 直测 — ${runId}（${prep.dataset} / ${new Date().toISOString().slice(0, 10)}）`);
  md.push('');
  md.push(`> 协议：每题**题面原句**一查（无模型参与、reinforce=false 不污染排序）；探针 topk=${topk}、min_score=0 拿门槛前候选（evidence/matched 随行带出）；**门槛后** = 本地复算真实准入（证据分 ≥ ${minScore} 或 词项命中 ≥ ${minMatched}，与服务端默认同口径，CLI 可覆写）；**全量** = 探针带回序列内（≤ topk ${topk}）的 recall，不是全库。金标单元键由数据集 adapter 定义（对话集 = 会话键）；**干扰** = 域内非金标单元（底座噪声排进前排，正常读数非告警）。坐标与灌库对账见同目录 prepare.json。`);
  md.push('');
  md.push(`| qid | 题型 | 金标段 | 带回 | 过门槛 | 干扰 | 首中rank（门槛前/后） | recall@${ks.join('/')}（门槛前） | 门槛后 | 全量 |`);
  md.push(`|---|---|---|---|---|---|---|---|---|---|`);
  for (const r of results) {
    md.push(
      `| ${r.qid} | ${r.category} | ${r.goldN} | ${r.hits} | ${r.hitsGated} | ${r.noiseUnits} | ` +
      `${r.firstGoldRank ?? '无'} / ${r.firstGoldRankGated ?? '无'} | ` +
      `${ks.map(k => pct(r.recallRaw[String(k)])).join('/')} | ${ks.map(k => pct(r.recallGated[String(k)])).join('/')} | ${pct(r.recallFull)} |`,
    );
  }
  md.push(`| **均值** | | | | | | | **${ks.map(k => pct(meanK('recallRaw', k))).join('/')}** | **${ks.map(k => pct(meanK('recallGated', k))).join('/')}** | **${pct(doc.summary.meanRecallFull)}** |`);
  md.push('');
  md.push(`命中构成：题域会话数 ${results.map(r => `${r.qid}=${r.scopeN}`).join('、')}（干扰 = 域内非金标排进前排，金标排位看首中rank）；非金标占前排是排序质量问题（挤占注入预算），不是泄漏。`);
  const oos = results.filter(r => r.outOfScope.length > 0);
  md.push(
    oos.length === 0
      ? `越界命中（题域外单元）：0——与 prepare 串台验收同口径，隔离成立。`
      : `⚠ 越界命中（题域外单元）：${oos.map(r => `${r.qid}→${r.outOfScope.join(',')}`).join('；')}——隔离失效，先查 context 坐标。`,
  );
  const deg = results.filter(r => r.degraded);
  if (deg.length > 0) md.push(`⚠ 检索降级 ${deg.length} 题（embed 超时等，读数偏低仅供参考）：${deg.map(r => r.qid).join('、')}。`);
  writeFileSync(path.join(runRoot, 'recall.md'), md.join('\n') + '\n', 'utf8'); // 人读面：run 根

  console.log(`\nrecall ${runId}：均值（门槛前）${ks.map(k => `@${k}=${meanK('recallRaw', k).toFixed(2)}`).join(' ')}；门槛后 ${ks.map(k => `@${k}=${meanK('recallGated', k).toFixed(2)}`).join(' ')}`);
  console.log(`recall.json → ${path.join(runDir, 'recall.json')}`);
  console.log(`recall.md → ${path.join(runRoot, 'recall.md')}`);
}

main().catch(err => {
  console.error(String(err));
  process.exit(1);
});
