/**
 * LongMemEval-S adapter（对话形态示例一）：官方 longmemeval_s_cleaned.json → pack。
 * gold 单元 = 会话（answer ∪ haystack 里的 session 键）；scope = 全量 haystack
 * （LME 协议 gold ⊆ haystack——答案会话是语料本体，剥了它所有臂只能答不知道）。
 */
import type { Pack, PackRecord } from '../shared/pack.ts';
import type { DatasetAdapter } from './adapter.ts';
import { sessionsToConversations, sessionsToRecords, type DialogueSession } from './dialogue.ts';

interface LmeItem {
  question_id: string;
  question_type: string;
  question: string;
  question_date: string;
  answer: string;
  answer_session_ids: string[];
  haystack_dates: string[];
  haystack_session_ids: string[];
  haystack_sessions: Array<Array<{ role: string; content: string }>>;
}

function sanitizeId(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]/g, '_');
}

function build(raw: unknown, ids: string[]): Pack {
  const items = raw as LmeItem[];
  if (!Array.isArray(items) || items.length === 0) throw new Error('LME 原始数据为空或格式不对');
  const byId = new Map(items.map(item => [item.question_id, item]));
  const missing = ids.filter(id => !byId.has(id));
  if (missing.length > 0) throw new Error(`清单里 ${missing.length} 题不在数据集（前 3：${missing.slice(0, 3).join(', ')}）`);

  const sessions = new Map<string, DialogueSession>();
  const questions = ids.map(id => {
    const item = byId.get(id)!;
    item.haystack_session_ids.forEach((sid, k) => {
      if (sessions.has(sid)) return;
      const msgs = item.haystack_sessions[k] ?? [];
      sessions.set(sid, {
        sid: sanitizeId(sid),
        date: item.haystack_dates[k] ?? '',
        turns: msgs.map(m => ({ speaker: m.role, text: m.content })),
      });
    });
    return {
      id: item.question_id,
      dataset: 'lme',
      question: item.question,
      questionDate: item.question_date,
      goldAnswer: String(item.answer ?? ''), // LME 的 answer 在 JSON 里可能是数字（如 3）
      goldKeys: item.answer_session_ids.map(sanitizeId),
      scopeKeys: [...new Set([...item.answer_session_ids, ...item.haystack_session_ids].map(sanitizeId))],
      categoryLabel: item.question_type,
    };
  });

  // 对话按首现序输出（确定性）
  const ordered: DialogueSession[] = [];
  const seen = new Set<string>();
  for (const q of questions) {
    for (const k of q.scopeKeys) {
      if (seen.has(k)) continue;
      seen.add(k);
      const s = sessions.get(k);
      if (s) ordered.push(s);
    }
  }
  return {
    source: 'longmemeval_s_cleaned.json (LongMemEval-S, MIT) frozen subset',
    count: questions.length,
    questions,
    records: sessionsToRecords(ordered),
    conversations: sessionsToConversations(ordered),
  };
}

export const lmeAdapter: DatasetAdapter = {
  dataset: 'lme',
  rawFile: 'longmemeval_s_cleaned.json',
  judgeTracks: ['official', 'semantic'],
  defaultIdsFile: 'frozen/lme-126.json',
  buildPack: build,
  questionRecords(q, records: PackRecord[]): PackRecord[] {
    const scope = new Set(q.scopeKeys);
    return records.filter(r => scope.has(String(r.meta?.conversation ?? '')));
  },
  hitKey(hit) {
    return String(hit.meta?.sid ?? '');
  },
};
