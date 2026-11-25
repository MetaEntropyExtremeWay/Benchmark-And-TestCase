/** judge 纯逻辑测试：提示词规则完备性 + verdict 规整 + 盲三元组面。 */
import { describe, expect, it } from 'vitest';
import { JUDGE_SYSTEM, JUDGE_PROMPT_VERSION, judgeUser, normalizeVerdict, F1_MATCH_THRESHOLD } from '../shared/judge-core.ts';

describe('JUDGE_SYSTEM 提示词（口径完备性——改动须 bump JUDGE_PROMPT_VERSION）', () => {
  it('四条核心规则在位：语义轨、关键事实、对抗题、纯 JSON 输出契约', () => {
    expect(JUDGE_SYSTEM).toContain('语义等价');
    expect(JUDGE_SYSTEM).toContain('关键事实');
    expect(JUDGE_SYSTEM).toContain('未提及');
    expect(JUDGE_SYSTEM).toContain('"verdict"');
    expect(JUDGE_SYSTEM).toContain('"reason"');
  });

  it('不因字面重合判分（防 judge 退化成机械轨）', () => {
    expect(JUDGE_SYSTEM).toContain('不要用字面重合度判分');
  });

  it('v2 反向规则在位：金标为具体值时不知情表述一律错（judge 臆想对抗题的偏置修复）', () => {
    expect(JUDGE_SYSTEM).toContain('金标为具体值');
    expect(JUDGE_SYSTEM).toContain('一律错');
    expect(JUDGE_SYSTEM).toContain('不要自行推测');
  });

  it('版本号随口径演进（v2 = 对抗题幻觉偏置修复，存量须重判）', () => {
    expect(JUDGE_PROMPT_VERSION).toBe('v2');
  });
});

describe('judgeUser 盲三元组', () => {
  it('只有题面/金标/预测三行，无臂指纹', () => {
    const u = judgeUser('Q?', 'G', 'P');
    expect(u).toContain('题面：Q?');
    expect(u).toContain('金标：G');
    expect(u).toContain('预测：P');
    expect(u).not.toMatch(/臂|arm|inject|transcript/i);
  });
});

describe('normalizeVerdict 容错', () => {
  it('correct 家族', () => {
    expect(normalizeVerdict('correct')).toBe('correct');
    expect(normalizeVerdict('Correct')).toBe('correct');
    expect(normalizeVerdict('对')).toBe('correct');
  });

  it('wrong 家族与认不出（null = 未判，不猜）', () => {
    expect(normalizeVerdict('wrong')).toBe('wrong');
    expect(normalizeVerdict('incorrect')).toBe('wrong');
    expect(normalizeVerdict('错')).toBe('wrong');
    expect(normalizeVerdict('maybe')).toBeNull();
    expect(normalizeVerdict(42)).toBeNull();
    expect(normalizeVerdict(undefined)).toBeNull();
  });
});

describe('F1 阈值', () => {
  it('阈值是导出常量（judge.json 与样例表引用同一来源）', () => {
    expect(F1_MATCH_THRESHOLD).toBeGreaterThan(0);
    expect(F1_MATCH_THRESHOLD).toBeLessThan(1);
  });
});
