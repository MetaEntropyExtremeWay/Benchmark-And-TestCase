/** 跨线共享的通用类型（数据集形状见 shared/pack.ts；数据集形态逻辑在 datasets/ adapter 层）。 */

export interface SearchHit {
  mem_id: string;
  name: string;
  kind: string;
  doc: string;
  meta: Record<string, unknown> | null;
  /** 诊断探针字段（仅 min_score 覆盖请求才带）：证据分与全文路词项命中数——门槛效果本地复算用 */
  evidence?: number;
  matched?: number;
}

export interface TokenUsage {
  prompt: number;
  completion: number;
}
