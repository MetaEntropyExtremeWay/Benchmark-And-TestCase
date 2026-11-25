/**
 * 题集 pack 抽取（download.ps1 之后、一切跑分之前的一次性成型步骤）：
 * 数据集 adapter（datasets/registry.ts）把官方原始数据按冻结清单确定性抽取
 * → data/<dataset>-pack.json（题目 + records [+ conversations] 全量，全链共用；
 * 之后各阶段不再解析原始数据集大文件）。
 * 确定性：无随机、按官方文件序取题、records 按首现序——同输入必同输出；
 * 上游数据集更新 = 显式重抽 + 重灌库（clean 指纹兜底）。
 * 用法：npx tsx shared/scripts/extract.ts [--dataset=lme|locomo] [--ids=<清单.json>]
 *                                       [--out=data/<dataset>-pack.json]
 * 第三方数据集：datasets/ 下加 adapter 并注册（见 datasets/adapter.ts），shared/ 零改动。
 */
import { writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../args.ts';
import { benchRoot } from '../config.ts';
import { packFile } from '../pack.ts';
import { getAdapter, listAdapters } from '../../datasets/registry.ts';
import { isProcessEntry } from '../entry.ts';

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const dataset = args.dataset ?? 'lme';
  const adapter = getAdapter(dataset);
  const outFile = args.out ?? path.join(benchRoot, 'data', packFile(dataset));
  const rawPath = path.join(benchRoot, 'data', adapter.rawFile);
  const raw = JSON.parse(readFileSync(rawPath, 'utf8')) as unknown;

  let ids: string[] = [];
  let idsNote = '（全量）';
  const idsFile = args.ids ?? (adapter.defaultIdsFile ? path.join(benchRoot, adapter.defaultIdsFile) : null);
  if (idsFile) {
    ids = (JSON.parse(readFileSync(idsFile, 'utf8')) as { questionIds?: string[] }).questionIds ?? [];
    if (ids.length === 0) throw new Error(`题集清单为空（${idsFile}）`);
    idsNote = args.ids ?? String(adapter.defaultIdsFile);
  }

  const pack = adapter.buildPack(raw, ids);
  const stats: Record<string, number> = {};
  for (const q of pack.questions) stats[q.categoryLabel] = (stats[q.categoryLabel] ?? 0) + 1;
  const out = {
    source: `${adapter.rawFile} per ${idsNote}`,
    count: pack.questions.length,
    questions: pack.questions,
    records: pack.records,
    ...(pack.conversations ? { conversations: pack.conversations } : {}),
  };
  writeFileSync(outFile, JSON.stringify(out), 'utf8');
  const mb = (Buffer.byteLength(JSON.stringify(out), 'utf8') / 1024 / 1024).toFixed(1);
  console.log(`pack → ${outFile}（${mb} MB）：${pack.questions.length} 题 / ${pack.records.length} records` +
    (pack.conversations ? ` / ${pack.conversations.length} conversations` : ''));
  console.log(`题型分布：${Object.entries(stats).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  console.log(`已注册数据集：${listAdapters().map(a => a.dataset).join(', ')}`);
}

if (isProcessEntry(import.meta.url)) void main();
