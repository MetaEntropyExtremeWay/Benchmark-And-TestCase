/**
 * 数据集注册表：加一个数据集 = 在本目录建 adapter 文件 + 这里注册一行，shared/ 零改动。
 */
import type { DatasetAdapter } from './adapter.ts';
import { lmeAdapter } from './lme.ts';
import { locomoAdapter } from './locomo.ts';

const ADAPTERS: DatasetAdapter[] = [lmeAdapter, locomoAdapter];

export function getAdapter(dataset: string): DatasetAdapter {
  const a = ADAPTERS.find(x => x.dataset === dataset);
  if (!a) {
    throw new Error(
      `未知数据集 '${dataset}'（已注册：${ADAPTERS.map(x => x.dataset).join(', ')}）——` +
        `接新数据集：datasets/ 下建 <name>.ts 实现 DatasetAdapter（照 lme.ts / locomo.ts），registry.ts 注册一行`,
    );
  }
  return a;
}

export function listAdapters(): DatasetAdapter[] {
  return [...ADAPTERS];
}
