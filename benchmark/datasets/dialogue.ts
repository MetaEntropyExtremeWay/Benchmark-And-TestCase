/**
 * 对话形态公共件（adapter 层底座——核心层 shared/pack.ts 零对话词汇）。
 * 把「一段段对话」装配成 pack 的通用机械：conversations（replay 线消费）+
 * records（记忆服务消费），两条产出自同一份会话数据，键系约定单源在此：
 *   record.key = `<convKey>#<n>`（n = 对话内轮序，0 起）
 *   record.date / meta.date = 会话日期；record.text = `speaker: text`
 *   record.meta = { conversation, sid, date, turn }（conversation 与 sid 同值——
 *   对话集的 gold 单元 = 会话键，sid 是命中行的计分键名）
 */
import type { PackConversation, PackQuestion, PackRecord } from '../shared/pack.ts';

export interface DialogueTurn {
  speaker: string;
  text: string;
}

export interface DialogueSession {
  sid: string;
  date: string;
  turns: DialogueTurn[];
}

export function sessionsToRecords(sessions: DialogueSession[]): PackRecord[] {
  const out: PackRecord[] = [];
  for (const s of sessions) {
    s.turns.forEach((t, i) => {
      out.push({
        key: `${s.sid}#${i}`,
        date: s.date,
        text: `${t.speaker}: ${t.text}`,
        meta: { conversation: s.sid, sid: s.sid, date: s.date, turn: i },
      });
    });
  }
  return out;
}

export function sessionsToConversations(sessions: DialogueSession[]): PackConversation[] {
  return sessions.map(s => ({ key: s.sid, date: s.date, turns: s.turns }));
}

/** 该题 scope 内的对话（replay 线）：conversation.key ∈ question.scopeKeys。
 *  缺失的 scope 对话如实计数（装载池缺会话的容忍口径由调用方决定）。 */
export function conversationsInScope(q: PackQuestion, conversations: PackConversation[]): { conversations: PackConversation[]; missing: number } {
  const byKey = new Map(conversations.map(c => [c.key, c]));
  const out: PackConversation[] = [];
  let missing = 0;
  for (const k of q.scopeKeys) {
    const c = byKey.get(k);
    if (c) out.push(c);
    else missing++;
  }
  return { conversations: out, missing };
}

/** 对话按 date 升序（stable——空 date 保持原序）：replay 写入时序贴对话时序。 */
export function conversationsByDate(conversations: PackConversation[]): PackConversation[] {
  return conversations
    .map((c, i) => ({ c, i }))
    .sort((a, b) => {
      const da = a.c.date || undefined;
      const db = b.c.date || undefined;
      if (da && db && da !== db) return da < db ? -1 : 1;
      return a.i - b.i;
    })
    .map(x => x.c);
}
