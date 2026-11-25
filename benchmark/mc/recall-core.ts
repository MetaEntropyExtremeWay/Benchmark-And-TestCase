/**
 * 检索直测纯函数（金标证据级 recall 独立读数）：
 * 探针（原问句、min_score=0、reinforce=false）拿到 ranked 候选后，
 * 本地算 recall@k 阶梯与准入门槛效果（门槛 = 证据分 ≥ minScore 或 词项命中 ≥ minMatched，
 * 与 mc search 配置同口径；探针调 0 拿门槛前候选，真实门槛在此复算）。
 * 金标单元键由调用方抽（adapter.hitKey）——本件只管集合与 rank 前缀，零数据集词汇。
 */

/** 探针行最小形状（search 响应行的 bench 侧投影）。 */
export interface ProbeRow {
  name: string;
  unit: string; // gold 单元键（adapter.hitKey 的产出）；空 = meta 缺键（按 miss 计并上游告警）
  evidence?: number | null;
  matched?: number | null;
}

/** 准入门槛：证据分 ≥ minScore 或 词项命中 ≥ minMatched（与 mc search 默认同口径）。 */
export function gatePass(row: ProbeRow, minScore: number, minMatched: number): boolean {
  return (row.evidence ?? 0) >= minScore || (row.matched ?? 0) >= minMatched;
}

export function gatedRows(rows: ProbeRow[], minScore: number, minMatched: number): ProbeRow[] {
  return rows.filter(r => gatePass(r, minScore, minMatched));
}

/** 会话/单元键级 recall@k：rank 前缀内命中的 gold 单元 ÷ gold 总数。 */
export function recallAtK(units: string[], gold: Set<string>, k: number): number {
  if (gold.size === 0) return 0;
  const hit = new Set<string>();
  for (const u of units.slice(0, k)) {
    if (gold.has(u)) hit.add(u);
  }
  return hit.size / gold.size;
}

/** 首个 gold 单元的 rank（1 起；无则 null）。 */
export function firstGoldRank(units: string[], gold: Set<string>): number | null {
  for (let i = 0; i < units.length; i++) {
    if (gold.has(units[i])) return i + 1;
  }
  return null;
}
