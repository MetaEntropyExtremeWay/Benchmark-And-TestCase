/**
 * ingest：pack records → 逐条 doc-save / skill-save（MemClient.batchUpsert）。
 * 零 LLM 加工（机械可复现）；一条 record = 一条 mc 记录（数据原子性对齐：
 * 证据可对账不劣于数据源粒度、原文完整）。对话形态的 record 形状（key =
 * `<convKey>#<n>`、doc 首行 date、meta 带会话归因键）由 datasets/dialogue.ts
 * 约定——本件对 record 形态零假设。
 */
import type { PackRecord } from '../shared/pack.ts';
import type { UpsertOp } from '../shared/mem.ts';

export interface IngestResult {
  ops: UpsertOp[];
  /** 实际产出 op 数（= 传入 record 数，留对账） */
  recordCount: number;
}

export function buildOps(records: PackRecord[], contextId: string): IngestResult {
  const ops: UpsertOp[] = records.map(r => ({
    context_id: contextId,
    kind: 'is',
    name: r.key,
    doc: r.date ? `date: ${r.date}\n${r.text}` : r.text,
    meta: { bench: true, ...(r.meta ?? {}) },
  }));
  return { ops, recordCount: records.length };
}
