/**
 * 机械评分指标（判分 LLM 轨的机械对照轨）：normalize / 词干 / F1 规则照官方
 * evaluation 实现口径抄，不自己发明——normalizeAnswer：去逗号 → 去冠词(a/an/the/and)
 * → 去标点 → 小写 → 空白合并；token 先 Porter 词干化再算 F1。
 */
import { stem } from './porter.ts';

export function normalizeAnswer(s: string): string {
  // 官方顺序：去逗号 → 小写 → 去标点 → 去冠词 → 空白合并（冠词在小写后去，别颠倒）。
  // String() 防御：LME 的 gold answer 在 JSON 里可能是数字（如 3），Python str() 等价
  const src = String(s);
  const noComma = src.replace(/,/g, '').toLowerCase();
  const noPunc = noComma.replace(/[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/g, '');
  const noArticles = noPunc.replace(/\b(a|an|the|and)\b/g, ' ');
  return noArticles.split(/\s+/).filter(Boolean).join(' ');
}

function tokens(s: string): string[] {
  return normalizeAnswer(s).split(' ').filter(Boolean).map(stem);
}

export function f1Score(prediction: string, groundTruth: string): number {
  const pred = tokens(prediction);
  const gold = tokens(groundTruth);
  if (pred.length === 0 || gold.length === 0) {
    // 官方实现：num_same=0 时返回 0（一侧为空同样 0，防御除零）
    return 0;
  }
  const common = new Map<string, number>();
  for (const t of pred) common.set(t, (common.get(t) ?? 0) + 1);
  let numSame = 0;
  for (const t of gold) {
    const c = common.get(t) ?? 0;
    if (c > 0) {
      numSame++;
      common.set(t, c - 1);
    }
  }
  if (numSame === 0) return 0;
  const precision = numSame / pred.length;
  const recall = numSame / gold.length;
  return (2 * precision * recall) / (precision + recall);
}
