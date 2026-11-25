/**
 * 题面契约（跨对象单源）：中性措辞 + 提问时刻基准 + FINAL_ANSWER 末行；官方 hint 原样透传。
 * mc 侧四臂作为题面骨架；lmg 侧 E 臂把它折单行喂 pipe——两线同一契约，判分抽答案同锚。
 */
import type { PackQuestion } from './pack.ts';

export function basePrompt(q: PackQuestion): string {
  const lines: string[] = [];
  if (q.questionDate) lines.push(`Question date: ${q.questionDate}`);
  if (q.hint) lines.push(q.hint);
  lines.push('', q.question, '', 'End your reply with a final line in exactly this format:', 'FINAL_ANSWER: <your answer>');
  return lines.join('\n') + '\n';
}
