import { describe, it, expect } from 'vitest';
import { gatePass, gatedRows, recallAtK, firstGoldRank, type ProbeRow } from '../mc/recall-core.ts';

const row = (over: Partial<ProbeRow>): ProbeRow => ({ name: 'x#1', sid: 's1', evidence: null, matched: null, ...over });

describe('gatePass（准入门槛本地复算）', () => {
  it('证据分过线即过（无论命中数）', () => {
    expect(gatePass(row({ evidence: 0.05, matched: 0 }), 0.05, 2)).toBe(true);
    expect(gatePass(row({ evidence: 0.3, matched: 0 }), 0.05, 2)).toBe(true);
  });
  it('词项命中数达标也过（证据分缺位——向量缺位的真部分交叠路径）', () => {
    expect(gatePass(row({ evidence: 0.01, matched: 2 }), 0.05, 2)).toBe(true);
    expect(gatePass(row({ evidence: null, matched: 3 }), 0.05, 2)).toBe(true);
  });
  it('双缺或双不达标不过', () => {
    expect(gatePass(row({ evidence: 0.049, matched: 1 }), 0.05, 2)).toBe(false);
    expect(gatePass(row({ evidence: null, matched: null }), 0.05, 2)).toBe(false);
    expect(gatePass(row({ evidence: 0, matched: 0 }), 0.05, 2)).toBe(false);
  });
});

describe('gatedRows（门槛后保持 rank 顺序）', () => {
  it('过滤不过门槛的行且不重排', () => {
    const rows = [row({ sid: 'a', evidence: 0.4 }), row({ sid: 'b', evidence: 0.01, matched: 0 }), row({ sid: 'c', matched: 2 })];
    expect(gatedRows(rows, 0.05, 2).map(r => r.sid)).toEqual(['a', 'c']);
  });
});

describe('recallAtK（rank 前缀 + 去重）', () => {
  const gold = new Set(['g1', 'g2']);
  it('前 k 截断：金标在前缀内才计', () => {
    expect(recallAtK(['g1', 'x', 'g2'], gold, 1)).toBe(0.5);
    expect(recallAtK(['g1', 'x', 'g2'], gold, 3)).toBe(1);
    expect(recallAtK(['x', 'x', 'x'], gold, 3)).toBe(0);
  });
  it('同键多行只计一次（一轮一条粒度下同会话多行是常态）', () => {
    expect(recallAtK(['g1', 'g1', 'g1'], gold, 3)).toBe(0.5);
  });
  it('金标空集恒 0（数据集异常护堤）', () => {
    expect(recallAtK(['g1'], new Set(), 3)).toBe(0);
  });
  it('k 超序列长 = 全量 recall', () => {
    expect(recallAtK(['x', 'g2'], gold, 99)).toBe(0.5);
  });
});

describe('firstGoldRank（1-based；null = 缺席）', () => {
  it('首中位置与全程未中可分（归因区分「深埋」与「缺席」）', () => {
    const gold = new Set(['g1']);
    expect(firstGoldRank(['x', 'g1'], gold)).toBe(2);
    expect(firstGoldRank(['x', 'x'], gold)).toBeNull();
    expect(firstGoldRank([], gold)).toBeNull();
  });
});
