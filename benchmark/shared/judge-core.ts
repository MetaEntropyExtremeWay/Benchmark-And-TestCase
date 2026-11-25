/**
 * judge 纯逻辑：提示词 + 判分输出规整（判分轨）。
 * 与编排分离，可测；提示词改动 = 判分口径改动，必须 bump JUDGE_PROMPT_VERSION
 * 并对存量重判（可比性保障）。
 */

/** 判分提示词版本（进 judge.json 与报告配置清单）。
 *  v2：补「金标为具体值时不知情表述一律错」——v1 实测 judge 会臆想「该题是对抗题」
 *  把「无法得知」判对（v1 实测出现过的偏置），必须对存量重判。 */
export const JUDGE_PROMPT_VERSION = 'v2';

export const JUDGE_SYSTEM = `你是判分器。给你一道题的题面、标准答案（金标）与某系统的预测答案，判预测对错。

规则：
- 预测与金标语义等价，或包含金标的关键事实 → 对。表述、大小写、格式、单位写法、语言上的差异不算错；不要用字面重合度判分。
- 预测与金标事实冲突、或漏掉关键事实（只答了金标的一部分而金标是完整答案）→ 错。
- 金标为「未提及」时（对抗题）：预测明确表示没有提到过 / 不知道 / 无相关信息 → 对；给出了任何具体事实 → 错。
- 金标为具体值时（与上一条对称的反向规则）：预测回答「无法得知 / 不知道 / 没有相关记录」等任何不知情表述 → 一律错。不要自行推测「该信息应该不可得」或「这题是对抗题」——金标给了具体值就说明应答得出，只按预测与金标是否相符判分，不因答案坦诚、谨慎而放宽。
- 预测含多余的额外信息但金标事实在其中 → 仍判对（不因多答扣错）。
- 只看答案内容，不管语气、措辞与完整句式。

输出严格 JSON（不要输出其他内容）：
{"verdict":"correct" 或 "wrong","reason":"一句话理由（指出对在哪 / 错在哪）"}`;

/** 盲三元组 user 面（判分器不知道答案是谁答的——剥掉臂的指纹）。 */
export function judgeUser(question: string, gold: string, pred: string): string {
  return [
    `题面：${question}`,
    `金标：${gold}`,
    `预测：${pred}`,
  ].join('\n');
}

/** 规整 judge 输出的 verdict：容错大小写与中文对错字，认不出给 null（记未判，不猜）。 */
export function normalizeVerdict(v: unknown): 'correct' | 'wrong' | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  if (s === 'correct' || s === '对' || s === 'true') return 'correct';
  if (s === 'wrong' || s === 'incorrect' || s === '错' || s === 'false') return 'wrong';
  return null;
}

/** 机械轨判对阈值（SQuAD 惯例口径；连续值照报，阈值只产对照用的 0/1）。 */
export const F1_MATCH_THRESHOLD = 0.6;
