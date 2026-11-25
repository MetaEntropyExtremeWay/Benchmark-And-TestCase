import { describe, expect, it } from 'vitest';
import { latestResetEpochMs, parseQuotaRunArgs } from '../shared/quota-run.ts';

describe('latestResetEpochMs（额度重置时间提取）', () => {
  it('单报文 → 解析为本地时间戳', () => {
    const t = latestResetEpochMs('API Error: Request rejected (429) · [1308][已达到 5 小时的使用上限。您的限额将在 2026-11-20 19:27:13 重置。][20261120175848d4c17acdd1f14a35]');
    expect(t).toBe(new Date('2026-11-20T19:27:13').getTime());
  });

  it('多报文取最新（跨窗后见者为准）', () => {
    const text = [
      '您的限额将在 2026-11-20 19:27:13 重置。',
      '进度 100/6047（err 0）',
      '您的限额将在 2026-11-21 08:02:41 重置。',
    ].join('\n');
    expect(latestResetEpochMs(text)).toBe(new Date('2026-11-21T08:02:41').getTime());
  });

  it('无匹配 → null（真错误透传路径）', () => {
    expect(latestResetEpochMs('TypeError: cannot read properties of undefined')).toBeNull();
  });
});

describe('parseQuotaRunArgs', () => {
  it('选项 + -- 后命令原样收集', () => {
    const o = parseQuotaRunArgs(['--buffer-sec=90', '--', 'npx', 'tsx', 'lmg/qa.ts', '--arm=e-deep', '--tag=smoke']);
    expect(o.bufferSec).toBe(90);
    expect(o.maxAttempts).toBe(40);
    expect(o.pollMin).toBe(20);
    expect(o.cmd).toEqual(['npx', 'tsx', 'lmg/qa.ts', '--arm=e-deep', '--tag=smoke']);
  });

  it('缺命令 → 抛错（防空跑）', () => {
    expect(() => parseQuotaRunArgs(['--poll-min=5', '--'])).toThrow();
  });

  it('隐式分隔（壳链剥 --）：首个非选项 token 起视为命令', () => {
    const o = parseQuotaRunArgs(['npx', 'tsx', 'lmg/formation.ts', '--dataset=lme', '--verify']);
    expect(o.cmd).toEqual(['npx', 'tsx', 'lmg/formation.ts', '--dataset=lme', '--verify']);
    expect(o.bufferSec).toBe(120);
  });

  it('未知选项 → 抛错', () => {
    expect(() => parseQuotaRunArgs(['--jobs=4', '--', 'echo', 'hi'])).toThrow();
  });
});
