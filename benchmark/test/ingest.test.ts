// ingest 单测：对话 adapter（sessionsToRecords）→ buildOps（records → ops）的组合契约：
// name 编码轮号（key）、meta 带对账字段、doc 形状、op 数与 record 数对账。
// 对话键系约定（`sid#n` / meta.conversation）单源在 datasets/dialogue.ts。
import { describe, it, expect } from 'vitest';
import { buildOps } from '../mc/ingest.ts';
import { sessionsToRecords } from '../datasets/dialogue.ts';
import type { DialogueSession } from '../datasets/dialogue.ts';

const CX = '/root/bench-abc12345';

function sess(sid: string, turns: [string, string][], date = '2024-01-01'): DialogueSession {
  return { sid, date, turns: turns.map(([speaker, text]) => ({ speaker, text })) };
}

describe('sessionsToRecords + buildOps（对话形态灌库契约）', () => {
  const records = sessionsToRecords([
    sess('s1', [['user', '你好'], ['assistant', '在的'], ['user', '再见']]),
    sess('s2', [['user', '第二段']], '2024-03-05'),
  ]);
  const r = buildOps(records, CX);

  it('record key = sid#轮号（轮号从 0 起）；op 总数 = record 数', () => {
    expect(r.ops.map(o => o.name)).toEqual(['s1#0', 's1#1', 's1#2', 's2#0']);
    expect(r.recordCount).toBe(4);
  });

  it('doc = date 首行 + speaker: text（检索面拿到的就是这两样）', () => {
    expect(r.ops[0].doc).toBe('date: 2024-01-01\nuser: 你好');
    expect(r.ops[3].doc).toBe('date: 2024-03-05\nuser: 第二段');
  });

  it('meta 携带对账字段（bench 标记 / conversation / sid / date / 会话内序号）', () => {
    expect(r.ops[2].meta).toEqual({ bench: true, conversation: 's1', sid: 's1', date: '2024-01-01', turn: 2 });
  });

  it('upsert 契约：context_id / kind 不变', () => {
    for (const o of r.ops) {
      expect(o.context_id).toBe(CX);
      expect(o.kind).toBe('is');
    }
  });

  it('空对话零 record；op 总数 = record 数（对账口径）', () => {
    const recs = sessionsToRecords([sess('empty', []), sess('s3', [['user', 'x']])]);
    expect(recs.map(x => x.key)).toEqual(['s3#0']);
    const r2 = buildOps(recs, CX);
    expect(r2.ops.length).toBe(recs.length);
  });

  it('record key 全局唯一（跨对话不串）——upsert 替换语义的改名安全垫', () => {
    const names = r.ops.map(o => o.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
