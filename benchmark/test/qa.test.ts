/** qa 驱动抽取与题面契约：FINAL_ANSWER 行中容忍（模型可不换行直书——实跑
 *  冒烟实测）、占位示例排除（指令回显不算答）、末次命中优先；契约字面缺席时的
 *  备式标记兜底（契约优先、只认行首）；收口门（答案行 + 提示符再现）；题面单行折叠；
 *  ask_user 等待提示符计数（首跑 25/50 悬挂回归锚——pipe 线格式不出工具名
 *  字面量，早期版本锚 `ask_user(` 永不命中）；判分输入状态映射（E 臂判分件）。 */
import { describe, expect, it } from 'vitest';
import { countAskPrompts, ePromptOneline, pickFinalAnswer, turnClosed } from '../lmg/qa.ts';
import { qaRecordToInput } from '../lmg/judge-qa.ts';
import type { QaRecord } from '../lmg/qa.ts';
import type { PackQuestion } from '../shared/pack.ts';

const rec = (over: Partial<QaRecord>): QaRecord => ({
  qid: 'q1',
  arm: 'default',
  context: '/root/bench-lme-q1/qa-default',
  exitCode: 0,
  timedOut: false,
  durationMs: 1000,
  answer: null,
  prompt: 'p',
  stdoutFile: 'f',
  at: '2026-11-20T00:00:00.000Z',
  ...over,
});

const q: PackQuestion = {
  id: 'q1',
  dataset: 'lme',
  question: 'How often do I attend yoga classes?',
  questionDate: '2023/12/14 (Thu) 06:32',
  goldAnswer: 'Three times a week.',
  goldSessions: ['s_gold'],
};

describe('pickFinalAnswer（契约字面 FINAL_ANSWER）', () => {
  it('行首形态：经典作答', () => {
    expect(pickFinalAnswer('FINAL_ANSWER: 每周两次\n')).toEqual({ answer: '每周两次', via: 'contract' });
  });

  it('行中形态：模型不换行直书（冒烟实测）', () => {
    const stdout = '我可以帮你记下来。FINAL_ANSWER: 无相关记录——记忆中未找到\n你> ';
    expect(pickFinalAnswer(stdout).answer).toBe('无相关记录——记忆中未找到');
  });

  it('占位示例排除：指令回显不算答', () => {
    expect(pickFinalAnswer('格式要求：FINAL_ANSWER: <your answer>').answer).toBeNull();
  });

  it('末次命中优先：先回显后作答取作答', () => {
    const stdout = '格式是 FINAL_ANSWER: <your answer>，作答如下\nFINAL_ANSWER: 每周两次\n';
    expect(pickFinalAnswer(stdout).answer).toBe('每周两次');
  });

  it('无命中 → null', () => {
    expect(pickFinalAnswer('模型没有按格式作答').answer).toBeNull();
  });
});

/** 实跑转录的收尾形态：模型改用中文作答，收尾标记也写成中文——契约字面
 *  `FINAL_ANSWER:` 缺席，旧判法（只认契约字面）空等到超时、记无答。 */
const DEVIATED_TAIL = '[回复]\n根据记忆中的记录，你一共进行过两次社交媒体休息：\n\n总计：7 + 10 = 17 天。\n最终答案：17 天\n\n\n你> \n再见！';

describe('pickFinalAnswer（契约字面优先，缺席才认备式标记）', () => {
  it('契约字面缺席 + 「最终答案：」→ 备式兜底（旧判法 = 空等到超时记无答）', () => {
    expect(pickFinalAnswer(DEVIATED_TAIL)).toEqual({ answer: '17 天', via: 'fallback' });
  });

  it('契约字面在场：同回合的备式标记不参与，结果与只有契约一式时逐字相同', () => {
    expect(pickFinalAnswer('最终答案：甲\nFINAL_ANSWER: 乙\n你> ')).toEqual({ answer: '乙', via: 'contract' });
    expect(pickFinalAnswer('我可以帮你记下来。FINAL_ANSWER: 无相关记录\n')).toEqual({ answer: '无相关记录', via: 'contract' });
  });

  it('契约字面只剩占位回显 = 缺席 → 备式可兜底（粗体装饰容忍）', () => {
    expect(pickFinalAnswer('格式要求：FINAL_ANSWER: <your answer>\n**最终答案：** 17 天\n')).toEqual({ answer: '17 天', via: 'fallback' });
  });

  it('备式只认行首：推理正文行中的「所以最终答案：」不算（宁漏不误取）', () => {
    expect(pickFinalAnswer('我核对了两段记录，所以最终答案：17 天\n')).toEqual({ answer: null, via: null });
  });

  it('备式英文变体：final answer（不分大小写）/ 契约字面配全角冒号', () => {
    expect(pickFinalAnswer('Final answer: 17 days\n')).toEqual({ answer: '17 days', via: 'fallback' });
    expect(pickFinalAnswer('FINAL_ANSWER：17 days\n')).toEqual({ answer: '17 days', via: 'fallback' });
  });

  it('备式占位示例排除', () => {
    expect(pickFinalAnswer('最终答案: <your answer>\n')).toEqual({ answer: null, via: null });
  });

  it('两式都无 → 无答案', () => {
    expect(pickFinalAnswer('模型没有按格式作答\n你> \n')).toEqual({ answer: null, via: null });
  });

  it('备式末次命中优先（同契约一式）', () => {
    expect(pickFinalAnswer('最终答案：见下\n最终答案：17 天\n').answer).toBe('17 天');
  });
});

describe('turnClosed（收口门：答案行已见且提示符再现）', () => {
  it('契约字面 + 第 2 次提示符 → 收口', () => {
    expect(turnClosed('=== LMG ===\n你> \n[回复]\n不知道\nFINAL_ANSWER: 无相关记录\n\n你> \n')).toBe(true);
  });

  it('备式标记 + 第 2 次提示符 → 收口（旧门只认契约字面：本形态空等到超时）', () => {
    expect(turnClosed('=== LMG ===\n你> \n' + DEVIATED_TAIL)).toBe(true);
  });

  it('答案行已见但回合未收口（提示符只 1 次）→ 不收（防推理中引用格式措辞被截断）', () => {
    expect(turnClosed('=== LMG ===\n你> \n[生成]\nFINAL_ANSWER: 稍等\n')).toBe(false);
  });

  it('回合收口但无答案行 / 只有占位回显 → 不收', () => {
    expect(turnClosed('=== LMG ===\n你> \n[回复]\n我需要更多信息\n\n你> \n')).toBe(false);
    expect(turnClosed('=== LMG ===\n你> \nFINAL_ANSWER: <your answer>\n\n你> \n')).toBe(false);
  });
});

describe('countAskPrompts（ask_user 等待提示符计数）', () => {
  it('问题行 + 答> 提示符（流尾无换行）→ 1（悬挂实测形态）', () => {
    expect(countAskPrompts('你的总时长大概有多少小时？\n答> ')).toBe(1);
  });

  it('提示符行带尾文不算（须整行只有提示符）', () => {
    expect(countAskPrompts('答> 这行有正文')).toBe(0);
  });

  it('行中「答>」字样与 你> 提示符均不计', () => {
    expect(countAskPrompts('模型说「答>」只是引用\n你> \nFINAL_ANSWER: x\n你> ')).toBe(0);
  });

  it('两次追问 = 2（各喂一次 steer）', () => {
    expect(countAskPrompts('问一？\n答> \nsteer 行作答\n问二？\n答> ')).toBe(2);
  });
});

describe('ePromptOneline（pipe 单行题面）', () => {
  it('多行 basePrompt 折单行、保留全部要素', () => {
    const p = ePromptOneline(q);
    expect(p.includes('\n')).toBe(false);
    expect(p).toContain('Question date: 2023/12/14 (Thu) 06:32');
    expect(p).toContain('How often do I attend yoga classes?');
    expect(p).toContain('FINAL_ANSWER: <your answer>');
  });

  it('suffix 追加（deep 臂显式深检索意图行）', () => {
    const p = ePromptOneline(q, ' Before answering, do a deep search of your memory for relevant records.');
    expect(p.endsWith('relevant records.')).toBe(true);
    expect(p).toContain('FINAL_ANSWER: <your answer> Before answering'); // 附加行接折叠题面末尾
  });
});

describe('qaRecordToInput（QaRecord → 判分输入状态映射）', () => {
  it('有答案 → ok（答案有效，进判分）', () => {
    expect(qaRecordToInput(rec({ answer: '每周两次' }))).toEqual({ qid: 'q1', status: 'ok', pred: '每周两次' });
  });

  it('有答案但 timedOut（抽到答案后杀树）→ 仍 ok', () => {
    expect(qaRecordToInput(rec({ answer: 'x', timedOut: true }))).toEqual({ qid: 'q1', status: 'ok', pred: 'x' });
  });

  it('无答案 + 超时 → timeout（流程问题不判、单列）', () => {
    expect(qaRecordToInput(rec({ timedOut: true, exitCode: null }))).toEqual({ qid: 'q1', status: 'timeout', pred: null });
  });

  it('无答案 + 未超时（进程死/无收口）→ error（不判、单列）', () => {
    expect(qaRecordToInput(rec({ exitCode: 1 }))).toEqual({ qid: 'q1', status: 'error', pred: null });
  });
});
