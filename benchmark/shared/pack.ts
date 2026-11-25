/**
 * 题集 pack 契约（通用核心，**零对话假设**）：一次记忆评测 = 要记住的 records +
 * 对它们的 questions。record 是任意形态的记忆条目（对话轮 / 文档 / 邮件 / 轨迹事件…），
 * 只有 key / date / text 三件事是核心层认识的。
 *
 * **接入新数据集**：不要改本文件——在 datasets/ 下写一个 adapter（见 datasets/adapter.ts）
 * 并在 datasets/registry.ts 注册一行，把原始数据组装成这里的形状即可。
 * lme / locomo 是随仓的两个对话形态 adapter 示例；对话扩展字段（conversations）的
 * 约定在 datasets/dialogue.ts，replay 线专用，核心层不消费。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

/** 一条要被记住的内容。key 全局唯一（灌库 name / 命中对账键）；date 可空（时间可检索面）。 */
export interface PackRecord {
  key: string;
  date?: string;
  text: string;
  meta?: Record<string, unknown>;
}

/** gold 单元 = 计分口径的最小键（adapter 定义：对话集 = 会话键，文档集 = 文档键…）。
 *  goldKeys / scopeKeys 都是**单元键**，不必然指向任何单条 record。 */
export interface PackQuestion {
  id: string;
  dataset: string;
  question: string;
  questionDate?: string;
  goldAnswer: string | null; // 弃权 / 对抗类题金标为空——判分走对应豁免
  goldKeys: string[];
  scopeKeys?: string[]; // 该题的信息底座（单元键全集）；goldKeys ⊆ scopeKeys
  categoryLabel: string; // 分桶维度（数据集自带题型 / 类别名）
  hint?: string; // 官方附加提示（原样透传题面）
  meta?: Record<string, unknown>; // adapter 自由扩展（对话扩展的会话映射等）
}

/** 对话扩展（可选）：replay 线消费的对话形态语料。约定见 datasets/dialogue.ts。 */
export interface PackConversation {
  key: string; // = 对话形态的 gold 单元键（会话键）
  date?: string;
  turns: Array<{ speaker: string; text: string }>;
}

export interface Pack {
  source: string;
  count: number;
  questions: PackQuestion[];
  records: PackRecord[];
  conversations?: PackConversation[];
}

/** 运行时 pack 文件名（extract.ts 产物，data/ 下 gitignored）。 */
export function packFile(dataset: string): string {
  return `${dataset}-pack.json`;
}

/** pack 加载（fail-loud：坏引用静默跳 = 读数无声失真）：count 对账、qid 唯一、
 *  dataset 一致、goldKeys ⊆ scopeKeys。单元键与 records 的对应关系是 adapter 的事，
 *  核心层不核（对话集的单元 = 会话键，文档集 = 文档键…）。 */
export function loadPack(dataDir: string, dataset: string): Pack {
  const file = path.join(dataDir, packFile(dataset));
  let raw: Pack;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8')) as Pack;
  } catch (err) {
    throw new Error(`题集 pack 读不了（${file}）——先下数据集再抽取：shared\\scripts\\download.ps1 → npx tsx shared/scripts/extract.ts --dataset=${dataset}（原始错误：${(err as Error).message}）`);
  }
  if (!Array.isArray(raw.questions) || raw.questions.length === 0) throw new Error(`题集 pack 为空或格式不对（${file}）`);
  if (raw.count !== raw.questions.length) throw new Error(`题集 pack count(${raw.count}) 与 questions 数(${raw.questions.length}) 不一致`);
  const seenQ = new Set<string>();
  for (const q of raw.questions) {
    if (seenQ.has(q.id)) throw new Error(`题集 pack 题 id 重复：${q.id}`);
    seenQ.add(q.id);
    if (q.dataset !== dataset) throw new Error(`题集 pack 题 ${q.id} dataset=${q.dataset} 与请求 ${dataset} 不一致（pack 装错了？）`);
    const scope = new Set(q.scopeKeys ?? []);
    const missing = q.goldKeys.filter(k => !scope.has(k));
    if (missing.length > 0) throw new Error(`题集 pack 题 ${q.id} 的 goldKeys 不在 scopeKeys 内（前 3：${missing.slice(0, 3).join(', ')}）`);
  }
  const seenR = new Set<string>();
  for (const r of raw.records) {
    if (seenR.has(r.key)) throw new Error(`题集 pack record key 重复：${r.key}`);
    seenR.add(r.key);
  }
  return raw;
}
