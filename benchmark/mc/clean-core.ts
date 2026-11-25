/**
 * 域内清场的纯决策层（clean.ts 的 CLI 壳之外的可测部分）。
 *
 * ingest 指纹的输入清单 = 数据源文件 + 灌库链代码：这些变了，库里旧内容与
 * 「现在重灌会得到的东西」不再可比，须重置；判分 / 读数等不碰库的
 * 逻辑不进指纹（改判分不清库——这是「分情况清」的分界线）。
 * 不在指纹内（升级属显式决策，走 --reset-db 手动重置）：mem 服务 jar、embed 模型。
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { packFile } from '../shared/pack.ts';

/** 指纹输入（repo 相对路径，清单顺序稳定进哈希）：数据源 pack 1 + 灌库链代码 5。 */
export function ingestFpInputs(dataset: string): string[] {
  return [
    `data/${packFile(dataset)}`, // 运行时题集 pack（extract.ts 产物——上游更新重抽即变化）
    'shared/pack.ts',       // pack 契约与加载
    'datasets/lme.ts',      // adapter：数据集形状（对话 → records/conversations）
    'mc/ingest.ts',        // buildOps：入库粒度与 op 形态
    'shared/mem.ts',        // batchUpsert / 排空语义（写入传输层）
    'mc/prepare.ts',       // 灌库循环与串台验收口径
    'shared/coords.ts',     // cwd 公式 + cwd → context 坐标映射（context 身份基串）
  ];
}

export interface FpInput {
  file: string;
  sha256: string;
}

export interface StoredFp {
  fp: string;
  createdAt?: string;
  inputs?: FpInput[];
}

/** 复合指纹：行 = `file:sha256`，整体再 sha256——文件名进哈希（改名/挪位也算变化）。 */
export function hashInputs(inputs: FpInput[]): string {
  return createHash('sha256').update(inputs.map(i => `${i.file}:${i.sha256}`).join('\n')).digest('hex');
}

/** 读域根 .ingest-fp；缺失/损坏/形状不对一律 null（= 库来历不可判，保守重置）。 */
export function readStoredFp(file: string): StoredFp | null {
  try {
    const doc = JSON.parse(readFileSync(file, 'utf8')) as StoredFp;
    return typeof doc.fp === 'string' && doc.fp.length > 0 ? doc : null;
  } catch {
    return null;
  }
}

export interface WipeEntry {
  name: string;
  isDir: boolean;
}

/**
 * 域根清场清单：全部子目录 + report-*.md 文件。
 * dotfile（.ingest-fp 等）与 shared/（跨 run 共享产物：变体 / 链 plan 缓存、探针
 * 记录）保留——前者是清场自身的账，后者设计上跨 run 复用，清了就丢了「同 plan
 * 跨轮对照」的性质；其余杂散文件保留——清场只删「单次任务的已知产物形态」。
 */
export function planWipe(entries: WipeEntry[]): string[] {
  return entries
    .filter(e => !e.name.startsWith('.'))
    .filter(e => e.name !== 'shared')
    .filter(e => e.isDir || /^report-.*\.md$/.test(e.name))
    .map(e => e.name);
}

export interface DbResetDecision {
  reset: boolean;
  reason: string;
}

/** 库重置决策：--reset-db 强置 > 指纹比对（无有效记录 = 保守重置）。 */
export function dbResetDecision(storedFp: string | null, currentFp: string, force: boolean): DbResetDecision {
  if (force) return { reset: true, reason: '--reset-db 手动强置' };
  if (storedFp === null) return { reset: true, reason: '无有效指纹记录（首次接入或 .ingest-fp 损坏）——库来历不可判，保守重置' };
  if (storedFp !== currentFp) return { reset: true, reason: 'ingest 指纹变化：数据源或灌库链代码变了' };
  return { reset: false, reason: '指纹一致——库保留（旧 run context 残留无害：检索按题域隔离，仅行数累积）' };
}
