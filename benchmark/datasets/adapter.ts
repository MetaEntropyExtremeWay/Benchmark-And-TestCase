/**
 * 数据集 adapter 接口：build（extract）与 read（灌库过滤 / 命中计分）两侧的桥。
 * 核心层（shared/pack.ts）只见通用 records 与 gold 单元键；数据集的具体形态
 * （对话 / 文档 / 轨迹…）全部收在 adapter 实现里。
 *
 * **加一个数据集**：①在本目录建 `<name>.ts` 实现 DatasetAdapter；②registry.ts 注册一行。
 * shared/ 零改动。
 */
import type { Pack, PackQuestion, PackRecord } from '../shared/pack.ts';
import type { SearchHit } from '../shared/types.ts';

export type JudgeTrack = 'official' | 'semantic';

export interface DatasetAdapter {
  dataset: string;
  /** 原始数据文件名（download.ps1 落 data/；extract.ts 读） */
  rawFile: string;
  /** 判分轨支持面：'official' = LongMemEval 官方模板口径（仅对齐该口径的题型有意义） */
  judgeTracks: JudgeTrack[];
  /** 原始数据 → pack。ids 白名单语义由各 adapter 自定（lme = 冻结清单必填、
   *  locomo = 可选全量）；ids 为空数组时按 adapter 自己的缺省语义处理。 */
  buildPack(raw: unknown, ids: string[]): Pack;
  /** 该题 scope 内的 records（灌库面：prepare 只灌这些） */
  questionRecords(q: PackQuestion, records: PackRecord[]): PackRecord[];
  /** 命中 → gold 单元键（recall / 串台验收的计分键；对话集 = 会话键） */
  hitKey(hit: SearchHit): string;
  /** extract CLI 的 ids 白名单缺省文件（frozen/ 下；null = 全量） */
  defaultIdsFile?: string;
}
