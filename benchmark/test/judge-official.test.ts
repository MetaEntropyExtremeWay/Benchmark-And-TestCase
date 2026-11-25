// 官方 judge 轨纯函数面：模板选择（分题型宽容条款在场）/ 占位顺序填参 /
// abstention 双保险判定 / contains-yes 判读语义（含官方口径的宽松面钉死）。
// LLM 调用与 driver 主链不在单测面。
import { describe, it, expect } from 'vitest';
import { officialPrompt, officialLabel, isAbstention, OFFICIAL_PROMPT_VERSION } from '../shared/judge-official-core.ts';

describe('officialPrompt 模板选择', () => {
  it('single-session-user / single-session-assistant / multi-session 共用基础模板', () => {
    for (const task of ['single-session-user', 'single-session-assistant', 'multi-session']) {
      const p = officialPrompt(task, 'Q1', 'A1', 'R1', false);
      expect(p).toContain('contains the correct answer');
      expect(p).not.toContain('off-by-one');
    }
  });

  it('temporal-reasoning：off-by-one 豁免条款在场（与基础模板的分型差）', () => {
    const p = officialPrompt('temporal-reasoning', 'Q1', 'A1', 'R1', false);
    expect(p).toContain('do not penalize off-by-one errors');
  });

  it('knowledge-update：宽容旧信息条款在场', () => {
    const p = officialPrompt('knowledge-update', 'Q1', 'A1', 'R1', false);
    expect(p).toContain('previous information along with an updated answer');
  });

  it('single-session-preference：rubric 措辞 + 不要求全覆盖条款在场', () => {
    const p = officialPrompt('single-session-preference', 'Q1', 'A1', 'R1', false);
    expect(p).toContain('Rubric: A1');
    expect(p).toContain('does not need to reflect all the points');
  });

  it('abstention：换 unanswerable 模板（题型字段不参与选择）', () => {
    const p = officialPrompt('whatever-type', 'Q1', 'A1', 'R1', true);
    expect(p).toContain('unanswerable');
    expect(p).toContain('Explanation: A1');
  });

  it('未知题型且非 abstention：抛错（官方 NotImplementedError 同款 fail fast）', () => {
    expect(() => officialPrompt('mystery-type', 'Q', 'A', 'R', false)).toThrow(/无此题型/);
  });

  it('占位顺序填参：question → answer → response（三段按序出现在模板空位）', () => {
    const p = officialPrompt('multi-session', 'QUESTION-X', 'ANSWER-Y', 'RESPONSE-Z', false);
    const qi = p.indexOf('QUESTION-X'), ai = p.indexOf('ANSWER-Y'), ri = p.indexOf('RESPONSE-Z');
    expect(qi).toBeGreaterThanOrEqual(0);
    expect(ai).toBeGreaterThan(qi);
    expect(ri).toBeGreaterThan(ai);
    expect(p).not.toContain('{}'); // 全部占位被消费
  });
});

describe('officialLabel 判读语义（官方 contains-yes 照抄）', () => {
  it('yes / Yes. / The answer is yes → 对（substring 语义是官方原样）', () => {
    expect(officialLabel('yes')).toBe(true);
    expect(officialLabel('Yes.')).toBe(true);
    expect(officialLabel('The answer is yes')).toBe(true);
  });
  it('no / empty → 错（bool(resp)=false 官方语义）', () => {
    expect(officialLabel('no')).toBe(false);
    expect(officialLabel('')).toBe(false);
    expect(officialLabel('   ')).toBe(false);
  });
});

describe('isAbstention 双保险', () => {
  it('qid _abs 后缀或 categoryLabel=abstention 任一命中', () => {
    expect(isAbstention('5d3d2817', 'multi-session')).toBe(false);
    expect(isAbstention('f685340e_abs', 'multi-session')).toBe(true);
    expect(isAbstention('f685340e', 'abstention')).toBe(true);
  });
});

it('版本标标识在场（读数声明锚点）', () => {
  expect(OFFICIAL_PROMPT_VERSION).toBe('official-evalqa-r1');
});
