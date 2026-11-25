import { describe, expect, it } from 'vitest';
import { parseJsonLoose } from '../shared/llm.ts';

describe('judge 输出 JSON 抠取', () => {
  it('裸 JSON', () => {
    expect(parseJsonLoose('{"correct": true, "reason": "same date"}')).toEqual({ correct: true, reason: 'same date' });
  });

  it('代码围栏与前后闲话', () => {
    const text = 'verdict:\n```json\n{"correct": false, "reason": "wrong year"}\n```\ndone';
    expect(parseJsonLoose(text)).toEqual({ correct: false, reason: 'wrong year' });
  });

  it('reason 里带花括号不误导括号配对', () => {
    const text = '{"correct": true, "reason": "gold {x} matches"}';
    expect(parseJsonLoose(text)).toEqual({ correct: true, reason: 'gold {x} matches' });
  });

  it('无 JSON → 抛错', () => {
    expect(() => parseJsonLoose('I think it is correct.')).toThrow();
  });
});
