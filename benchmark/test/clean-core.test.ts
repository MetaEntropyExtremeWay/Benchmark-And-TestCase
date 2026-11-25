import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  ingestFpInputs,
  hashInputs,
  readStoredFp,
  planWipe,
  dbResetDecision,
} from '../mc/clean-core.ts';

const tmp = mkdtempSync(path.join(tmpdir(), 'clean-core-'));
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('ingestFpInputs：指纹输入清单', () => {
  it('数据源 pack 1 + 灌库链代码 6 个（coords 合并了 paths+slug）', () => {
    const inputs = ingestFpInputs('lme');
    expect(inputs).toEqual([
      'data/lme-pack.json',
      'shared/pack.ts',
      'datasets/lme.ts',
      'mc/ingest.ts',
      'shared/mem.ts',
      'mc/prepare.ts',
      'shared/coords.ts',
    ]);
    // 清单顺序稳定（顺序进哈希）
    expect(inputs).toEqual([...inputs]);
  });
});

describe('hashInputs：复合指纹', () => {
  it('同输入同哈希（稳定，两次调用一致）', () => {
    const inputs = [{ file: 'a.ts', sha256: 'aa' }, { file: 'b.ts', sha256: 'bb' }];
    expect(hashInputs(inputs)).toBe(hashInputs(structuredClone(inputs)));
  });

  it('内容变（sha 变）→ 指纹变', () => {
    const a = hashInputs([{ file: 'a.ts', sha256: 'aa' }]);
    const b = hashInputs([{ file: 'a.ts', sha256: 'ab' }]);
    expect(a).not.toBe(b);
  });

  it('文件名变（内容同）→ 指纹变（改名/挪位也算变化）', () => {
    const a = hashInputs([{ file: 'old.ts', sha256: 'aa' }]);
    const b = hashInputs([{ file: 'new.ts', sha256: 'aa' }]);
    expect(a).not.toBe(b);
  });
});

describe('readStoredFp：存量指纹读取', () => {
  it('缺失 → null', () => {
    expect(readStoredFp(path.join(tmp, 'no-such-file'))).toBeNull();
  });

  it('合法文档 → fp 透传；损坏 JSON / 形状不对 → null', () => {
    const ok = path.join(tmp, 'ok.json');
    writeFileSync(ok, JSON.stringify({ fp: 'abc123', createdAt: '2026-09-12T00:00:00Z', inputs: [] }), 'utf8');
    expect(readStoredFp(ok)?.fp).toBe('abc123');

    const broken = path.join(tmp, 'broken.json');
    writeFileSync(broken, '{not json', 'utf8');
    expect(readStoredFp(broken)).toBeNull();

    const noFp = path.join(tmp, 'no-fp.json');
    writeFileSync(noFp, JSON.stringify({ createdAt: 'x' }), 'utf8');
    expect(readStoredFp(noFp)).toBeNull();
  });
});

describe('planWipe：域根清场清单', () => {
  it('子目录全清 + report-*.md 清；dotfile 与杂散文件保留', () => {
    const wipe = planWipe([
      { name: 'lme500-a-r1', isDir: true },
      { name: 'lme500-b', isDir: true },
      { name: 'report-202609120343.md', isDir: false },
      { name: '.ingest-fp', isDir: false },
      { name: '.scratch', isDir: true },
      { name: 'notes.txt', isDir: false },
      { name: 'scratch-report.md', isDir: false },
    ]);
    expect(wipe).toEqual(['lme500-a-r1', 'lme500-b', 'report-202609120343.md']);
  });

  it('空域 → 空清单', () => {
    expect(planWipe([])).toEqual([]);
  });
});

describe('dbResetDecision：库重置决策', () => {
  it('--reset-db 强置（即便指纹一致）', () => {
    const d = dbResetDecision('same', 'same', true);
    expect(d.reset).toBe(true);
    expect(d.reason).toContain('手动');
  });

  it('无有效记录 → 保守重置', () => {
    const d = dbResetDecision(null, 'fp-now', false);
    expect(d.reset).toBe(true);
  });

  it('指纹变化 → 重置', () => {
    const d = dbResetDecision('old', 'new', false);
    expect(d.reset).toBe(true);
    expect(d.reason).toContain('指纹');
  });

  it('指纹一致 → 保留', () => {
    const d = dbResetDecision('same', 'same', false);
    expect(d.reset).toBe(false);
  });
});
