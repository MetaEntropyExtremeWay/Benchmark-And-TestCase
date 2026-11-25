/**
 * LoCoMo adapter（对话形态示例二）：官方 locomo10.json → pack。
 * 一段对话（sample）= 一组会话；全段 qa 都以整段对话为底座（scope = 全部会话）；
 * gold 单元 = 会话（evidence "D<n>:<m>" → session_n）；cat5 对抗题金标为 null
 * （正确行为 = 识别「未提及」，判分走对抗豁免）。
 */
import type { Pack } from '../shared/pack.ts';
import type { DatasetAdapter } from './adapter.ts';
import { sessionsToConversations, sessionsToRecords, type DialogueSession } from './dialogue.ts';

interface LocomoTurn {
  speaker: string;
  dia_id: string;
  text: string;
}

interface LocomoQa {
  question: string;
  answer?: string | number;
  evidence: string[];
  category: number;
  adversarial_answer?: string;
}

interface LocomoSample {
  sample_id: string;
  conversation: Record<string, unknown>;
  qa: LocomoQa[];
}

/** LoCoMo 官方分类 → 分桶标签（本数据集的专有映射，只住本 adapter）。 */
const LOCOMO_CATEGORY_LABELS: Record<number, string> = {
  1: 'multi-hop',
  2: 'temporal',
  3: 'open-domain',
  4: 'single-hop',
  5: 'adversarial',
};

function sanitizeId(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]/g, '_');
}

function build(raw: unknown, ids: string[]): Pack {
  const samples = raw as LocomoSample[];
  if (!Array.isArray(samples) || samples.length === 0) throw new Error('LoCoMo 原始数据为空或格式不对');
  const sessions: DialogueSession[] = [];
  const questions = [];
  for (const conv of samples) {
    const sampleId = sanitizeId(String(conv.sample_id));
    const keyToSid = new Map<string, string>();
    const convSessions: DialogueSession[] = [];
    const c = conv.conversation;
    for (const key of Object.keys(c)) {
      const m = /^session_(\d+)$/.exec(key);
      if (!m) continue;
      const turns = (c[key] as LocomoTurn[]).map(t => ({ speaker: t.speaker, text: t.text }));
      const sid = `${sampleId}-s${m[1]}`;
      keyToSid.set(key, sid);
      convSessions.push({ sid, date: String(c[`session_${m[1]}_date_time`] ?? ''), turns });
    }
    sessions.push(...convSessions);

    conv.qa.forEach((qa, i) => {
      const id = `${sampleId}-qa${i}`;
      if (ids.length > 0 && !ids.includes(id)) return;
      const isAdv = qa.category === 5;
      questions.push({
        id,
        dataset: 'locomo',
        question: qa.question,
        goldAnswer: isAdv ? null : String(qa.answer ?? ''),
        goldKeys: [...new Set(qa.evidence.map(e => keyToSid.get(`session_${e.split(':')[0].slice(1)}`)).filter(Boolean))] as string[],
        scopeKeys: convSessions.map(s => s.sid),
        categoryLabel: LOCOMO_CATEGORY_LABELS[qa.category] ?? `cat-${qa.category}`,
        hint: qa.category === 2 ? 'Use DATE of CONVERSATION to answer with an approximate date.' : undefined,
      });
    });
  }
  const missing = ids.filter(id => !questions.some(q => q.id === id));
  if (missing.length > 0) throw new Error(`清单里 ${missing.length} 题不在数据集（前 3：${missing.slice(0, 3).join(', ')}）`);
  return {
    source: 'locomo10.json (LoCoMo, CC BY-NC 4.0) conversations',
    count: questions.length,
    questions,
    records: sessionsToRecords(sessions),
    conversations: sessionsToConversations(sessions),
  };
}

export const locomoAdapter: DatasetAdapter = {
  dataset: 'locomo',
  rawFile: 'locomo10.json',
  judgeTracks: ['semantic'], // 官方轨 = LongMemEval 分题型模板，LoCoMo 类别不适用
  buildPack: build,
  questionRecords(q, records) {
    const scope = new Set(q.scopeKeys);
    return records.filter(r => scope.has(String(r.meta?.conversation ?? '')));
  },
  hitKey(hit) {
    return String(hit.meta?.sid ?? '');
  },
};
