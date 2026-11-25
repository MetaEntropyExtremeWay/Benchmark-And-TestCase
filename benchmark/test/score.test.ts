import { describe, expect, it } from 'vitest';
import { normalizeAnswer, f1Score } from '../shared/score.ts';

describe('normalizeAnswer（官方口径）', () => {
  it('去逗号/冠词/标点、小写、空白合并', () => {
    expect(normalizeAnswer('The Seven, Habits')).toBe('seven habits');
    expect(normalizeAnswer('self-care is important')).toBe('selfcare is important');
    expect(normalizeAnswer('  a  B  ')).toBe('b');
  });
});

describe('token F1', () => {
  it('相同 → 1；无交集 → 0', () => {
    expect(f1Score('seven', 'seven')).toBe(1);
    expect(f1Score('seven', 'seventy')).toBe(0);
  });

  it('词干与冠词处理', () => {
    expect(f1Score('the playing of pianos', 'play piano')).toBeGreaterThan(0.5);
    expect(f1Score('Psychology', 'Psychology.')).toBe(1);
  });

  it('部分交叠给中间值', () => {
    // pred "counseling certification" vs gold "counseling"：P=1/2, R=1 → 2/3
    expect(f1Score('counseling certification', 'counseling')).toBeCloseTo(2 / 3, 3);
  });

  it('一侧为空 → 0（防御除零，官方同行为）', () => {
    expect(f1Score('x', '')).toBe(0);
    expect(f1Score('', 'x')).toBe(0);
  });
});
