// formation 纯函数面单测：链线几何公式（段净化/形状/碰撞）、ts 解析纪律、
// 题面 JSONL 形状（ts 两态）、formationSlots（金标剥除/时序/坐标命名/截断）。
// 契约锚点 = 跨题零串台（project 唯一性 fail-fast）与金标不进库（答题污染第一道闸）。
import { describe, it, expect } from 'vitest';
import { benchProjectId, benchFormationSession, qaSession, benchSegment, chainRunDir } from '../shared/coords.ts';
import { dateToEpochMs, conversationToReplayLines, formationSlots, assertProjectUnique } from '../lmg/formation.ts';
import type { PackQuestion, PackConversation } from '../shared/pack.ts';

function sess(sid: string, turns: [string, string][], date = '2024-01-01'): PackConversation {
  return { key: sid, date, turns: turns.map(([speaker, text]) => ({ speaker, text })) };
}

function q(over: Partial<PackQuestion> = {}): PackQuestion {
  return {
    id: 'q_1',
    dataset: 'lme',
    question: '问什么',
    goldAnswer: '答案',
    goldKeys: [],
    scopeKeys: [],
    categoryLabel: 'single-session-user',
    ...over,
  };
}

describe('链线几何公式（shared/coords.ts）', () => {
  it('project = /root/bench-<dataset>-<净化 key>；非法字符折叠、大写收敛', () => {
    expect(benchProjectId('lme', 'abc123')).toBe('/root/bench-lme-abc123');
    expect(benchProjectId('locomo', 'sample_7')).toBe('/root/bench-locomo-sample-7');
  });

  it('段净化：前缀承载身份（纯 CJK key 收敛到 /root/bench-lme，撞名由 assertProjectUnique 闸）；80 上限防病态长 id', () => {
    expect(benchProjectId('lme', '。。。')).toBe('/root/bench-lme');
    expect(benchProjectId('lme', '、、、')).toBe('/root/bench-lme'); // 同段——碰撞预检的用例
    expect(benchSegment('x'.repeat(200)).length).toBe(80);
  });

  it('formation session = <project>/s-<i>-<净化 sid>（s- 前缀 = parentProjectOf 剥段形状）', () => {
    expect(benchFormationSession('/root/bench-lme-abc', 0, 'sess_1')).toBe('/root/bench-lme-abc/s-0-sess-1');
    expect(benchFormationSession('/root/bench-lme-abc', 12, 'S_2')).toBe('/root/bench-lme-abc/s-12-s-2');
  });

  it('qa session = <project>/qa-<净化 arm>', () => {
    expect(qaSession('/root/bench-lme-abc', 'default')).toBe('/root/bench-lme-abc/qa-default');
    expect(qaSession('/root/bench-lme-abc', 'DEEP')).toBe('/root/bench-lme-abc/qa-deep');
  });

  it('run 树分域 chain/<runId>（与 mc 线 run 平级不混）', () => {
    expect(chainRunDir('D:/state', 'form').replaceAll('\\', '/')).toBe('D:/state/chain/form');
  });
});

describe('dateToEpochMs（ts 注入纪律）', () => {
  it('YYYY-MM-DD → 当日正午 UTC 毫秒', () => {
    expect(dateToEpochMs('2024-01-01')).toBe(Date.parse('2024-01-01T12:00:00Z'));
  });
  it('LME 源形态 YYYY/MM/DD (周几) HH:mm → 取日期段、同样正午（loader 不归一 haystack_dates）', () => {
    expect(dateToEpochMs('2023/03/31 (Fri) 09:12')).toBe(Date.parse('2023-03-31T12:00:00Z'));
    expect(dateToEpochMs('2023/03/31')).toBe(Date.parse('2023-03-31T12:00:00Z'));
    expect(dateToEpochMs('2023/12/31 (Sun) 23:40')).toBe(Date.parse('2023-12-31T12:00:00Z')); // 尾日不溢到次年
  });
  it('坏日期抛错不静默（时间轴失真比报错更糟）', () => {
    expect(() => dateToEpochMs('')).toThrow();
    expect(() => dateToEpochMs('yesterday')).toThrow();
    expect(() => dateToEpochMs('2023/13/01 (Fri) 10:00')).toThrow(); // 月越界
    expect(() => dateToEpochMs('2023-03-31T09:12:00Z')).toThrow(); // 日期段后非空格分隔的形态不收
    expect(() => dateToEpochMs('2023/03-31')).toThrow(); // 分隔符混用
  });
});

describe('conversationToReplayLines（题面 JSONL）', () => {
  const s = sess('s1', [
    ['user', '你好'],
    ['assistant', '在的'],
    ['user', '   '], // 空白轮跳过（replay 解析要求非空）
    ['system', 'x'], // 非 user/assistant → fail-fast
  ]);

  it('缺省（ts off）：每轮一对象、无 ts 键', () => {
    const lines = conversationToReplayLines(sess('s1', [['user', '你好'], ['assistant', '在的']]), false).trim().split('\n');
    expect(lines.map(l => JSON.parse(l))).toEqual([
      { user: '你好' },
      { assistant: '在的' },
    ]);
  });

  it('ts on：全会话同 ts（源数据日期粒度即会话级）', () => {
    const lines = conversationToReplayLines(sess('s1', [['user', '你好'], ['assistant', '在的']]), true).trim().split('\n');
    const ts = Date.parse('2024-01-01T12:00:00Z');
    expect(lines.map(l => JSON.parse(l))).toEqual([
      { user: '你好', ts },
      { assistant: '在的', ts },
    ]);
  });

  it('ts on：LME 真实日期形态走通（源数据原样即此形态——曾因只认 ISO 而整条 ts 路径不可用）', () => {
    const lines = conversationToReplayLines(sess('s1', [['user', 'x']], '2023/03/31 (Fri) 09:12'), true).trim().split('\n');
    expect(lines.map(l => JSON.parse(l))).toEqual([{ user: 'x', ts: Date.parse('2023-03-31T12:00:00Z') }]);
  });

  it('ts on 且日期坏 → 抛错（不静默漏 ts）', () => {
    expect(() => conversationToReplayLines(sess('s1', [['user', 'x']]), true)).not.toThrow(); // date 缺省 '2024-01-01'
    expect(() => conversationToReplayLines({ ...sess('s1', [['user', 'x']]), date: '' }, true)).toThrow();
  });

  it('非 user/assistant 角色 fail-fast', () => {
    expect(() => conversationToReplayLines(s, false)).toThrow(/system/);
  });
});

describe('formationSlots（haystack 全量含金标 + 时序 + 坐标）', () => {
  const sessions = [
    sess('s_b', [['user', 'b']], '2024-03-05'),
    sess('s_a', [['user', 'a']], '2024-01-01'),
    sess('s_gold', [['user', '题面']], '2024-06-01'),
  ];
  const question = q({
    id: 'qid_x',
    goldKeys: ['s_gold'],
    scopeKeys: ['s_gold', 's_b', 's_a'],
  });

  it('金标对话在库（对话基准协议 gold ⊆ scope——剥了答案对话所有臂只能答不知道）', () => {
    const r = formationSlots(question, sessions);
    expect(r.goldIncluded).toBe(1);
    expect(r.slots.map(s => s.convKey)).toEqual(['s_a', 's_b', 's_gold']); // date 升序，金标在内
  });

  it('坐标：project 一次、对话按时序 s-<i>-<key>', () => {
    const r = formationSlots(question, sessions);
    expect(r.slots[0].project).toBe('/root/bench-lme-qid-x');
    expect(r.slots[0].context).toBe('/root/bench-lme-qid-x/s-0-s-a');
    expect(r.slots[1].context).toBe('/root/bench-lme-qid-x/s-1-s-b');
    expect(r.slots[2].context).toBe('/root/bench-lme-qid-x/s-2-s-gold');
  });

  it('limitS 截前 N 对话（冒烟口径；截掉金标时 goldIncluded 如实归零）', () => {
    const r1 = formationSlots(question, sessions, 1);
    expect(r1.slots.map(s => s.convKey)).toEqual(['s_a']);
    expect(r1.goldIncluded).toBe(0); // 金标被截掉——读数无效的显式信号
    const r2 = formationSlots(question, sessions, 3);
    expect(r2.goldIncluded).toBe(1);
  });

  it('scope 里不在 conversations 映射的 key 静默缺（装载池缺对话的容忍）', () => {
    const r = formationSlots(q({ id: 'q2', scopeKeys: ['s_a', 's_missing'] }), sessions);
    expect(r.slots.map(s => s.convKey)).toEqual(['s_a']);
  });
});

describe('assertProjectUnique（跨题零串台 fail-fast）', () => {
  it('净化后同段 = 抛错（截 80 撞名即串台）', () => {
    const long1 = 'a'.repeat(100) + '1';
    const long2 = 'a'.repeat(100) + '2'; // 前 100 段同、净化截 80 后同段
    expect(() => assertProjectUnique([q({ id: long1 }), q({ id: long2 })])).toThrow(/碰撞/);
  });
  it('常规题集全唯一 → 通过', () => {
    expect(() => assertProjectUnique([q({ id: 'q_1' }), q({ id: 'q_2' })])).not.toThrow();
  });
});
