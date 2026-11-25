// slug/context 坐标单测：关键向量与 mc 仓 mem-mcp 包的 slug 单测互为镜像——
// 拷贝实现与源仓漂移时这里先红（验收另有 --doctor 实物比对兜底）。
import { describe, it, expect } from 'vitest';
import { normalizeDir, cleanSegment, slugFor, contextIdForCwd } from '../shared/coords.ts';

describe('normalizeDir', () => {
  it('反斜杠 / 大小写 / 尾斜杠 / 重复分隔符归一', () => {
    expect(normalizeDir('D:\\Work\\Proj-A')).toBe('d:/work/proj-a');
    expect(normalizeDir('d:/Work/Proj-A/')).toBe('d:/work/proj-a');
    expect(normalizeDir('D:\\\\Work//Proj-A')).toBe('d:/work/proj-a');
  });
});

describe('cleanSegment', () => {
  it('非法字符折叠、去首尾 -、截 32', () => {
    expect(cleanSegment('my_project')).toBe('my-project');
    expect(cleanSegment('My Project!')).toBe('my-project');
    expect(cleanSegment('我的项目')).toBe('');
    expect(cleanSegment('a'.repeat(50))).toHaveLength(32);
  });
});

describe('slugFor', () => {
  it('同一目录各种写法 → 同一 slug；形态 name-hash8（末段名取目录名）', () => {
    const a = slugFor('D:\\Work\\Proj-A');
    expect(slugFor('d:/work/proj-a')).toBe(a);
    expect(a).toMatch(/^[a-z0-9-]+-[0-9a-f]{8}$/);
    expect(a.startsWith('proj-a-')).toBe(true);
  });
  it('不同目录可分（runId 进路径 = 不同 context，重复跑天然一次性）', () => {
    expect(slugFor('D:\\Work\\bench\\r1\\cwd\\a\\q1')).not.toBe(
      slugFor('D:\\Work\\bench\\r2\\cwd\\a\\q1'),
    );
    expect(slugFor('D:\\a\\b')).not.toBe(slugFor('D:\\a\\c'));
  });
});

describe('contextIdForCwd', () => {
  it('形状 /root/<slug>（三层：project = 工作场景单段，宿主身份不进 project）', () => {
    expect(contextIdForCwd('D:\\x\\y')).toBe(`/root/${slugFor('D:\\x\\y')}`);
    expect(contextIdForCwd('/home/u/proj')).toMatch(/^\/root\/proj-[0-9a-f]{8}$/);
  });
});
