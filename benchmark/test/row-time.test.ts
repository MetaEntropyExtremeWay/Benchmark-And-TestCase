import { describe, expect, it } from 'vitest';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { isProcessEntry } from '../shared/entry.ts';
import {
  acquireRowTimeLease, assertRowTimeConsistent, assertRowTimeGeometry, beginRowTime, parseRowTimeMode, planRowTime,
  sqlEnsure, sqlReconcile, sqlRevert, BACKUP_TABLE,
} from '../lmg/row-time.ts';
import type { RowTimeLease, RowTimePeer, RowTimeStore, RowTimeTarget } from '../lmg/row-time.ts';
import { dateToEpochMs, formationSlots } from '../lmg/formation.ts';
import { benchProjectId } from '../shared/coords.ts';
import type { PackQuestion, PackConversation } from '../shared/pack.ts';

// ------------------------------------------------------------------ fixture

const sess = (sid: string, date: string): PackConversation => ({ key: sid, date, turns: [{ speaker: 'user', text: `t-${sid}` }] });
const q = (id: string, scope: string[]): PackQuestion => ({
  id, dataset: 'lme', question: `问 ${id}`, goldAnswer: 'x', goldKeys: [scope[0]!], scopeKeys: scope, categoryLabel: 'temporal-reasoning',
});

const SESS = [sess('sa', '2024-03-05'), sess('sb', '2024-03-07'), sess('sc', '2024-03-06')];
const Q1 = q('q1', ['sa', 'sb', 'sc']);
const PEER = (over: Partial<RowTimePeer> = {}): RowTimePeer => ({
  mode: 'replay', pid: 4321, at: '2026-11-23T00:00:00Z', label: 'e-def', phase: 'active', ...over,
});

/** 假租约：peers 由数组即时给出（可变），close / markEnding 记痕（经 getter 读到增量）。 */
function fakeLease(peers: RowTimePeer[]): RowTimeLease & { closed: number; endings: number } {
  const state = { closed: 0, endings: 0 };
  const self = PEER({ pid: process.pid });
  return {
    self,
    peers: async () => [...peers],
    markEnding: () => { self.phase = 'ending'; state.endings++; },
    close: async () => { state.closed++; },
    get closed() { return state.closed; },
    get endings() { return state.endings; },
  };
}

/** 假库面：行为全脚本化（over 覆盖），方法调用按名留痕。 */
function fakeStore(over: Partial<RowTimeStore> = {}): RowTimeStore & { calls: string[] } {
  const calls: string[] = [];
  const base: RowTimeStore = {
    backupExists: async () => false,
    backupStats: async () => null,
    contextsUnder: async () => [],
    ensure: async () => ({ changed: 0, planned: 0, backed: 0 }),
    reconcile: async () => ({ mismatch: 0, unbacked: 0, planned: 0, backed: 0 }),
    revert: async () => 0,
  };
  const store = Object.assign({}, base, over) as RowTimeStore;
  return new Proxy(store, {
    get(target, prop, receiver) {
      if (prop === 'calls') return calls;
      const v = Reflect.get(target, prop, receiver);
      if (typeof v === 'function' && typeof prop === 'string' && prop in base) calls.push(prop);
      return v;
    },
  }) as RowTimeStore & { calls: string[] };
}

// ------------------------------------------------------------------ 纯函数

describe('parseRowTimeMode', () => {
  it('缺省 → replay；两值各自通过', () => {
    expect(parseRowTimeMode(undefined)).toBe('replay');
    expect(parseRowTimeMode('replay')).toBe('replay');
    expect(parseRowTimeMode('source')).toBe('source');
  });
  it('坏值 → 抛（提示等号式写法）', () => {
    expect(() => parseRowTimeMode('src')).toThrow(/--row-time=source/);
    expect(() => parseRowTimeMode('')).toThrow();
  });
});

describe('planRowTime（槽位规划 → 会话节点 → 源日期时刻）', () => {
  it('映射 = formationSlots 槽位 × dateToEpochMs（与灌库同一条几何公式）', () => {
    const targets = planRowTime([Q1], SESS);
    expect(targets).toHaveLength(1);
    const t = targets[0]!;
    expect(t.qid).toBe('q1');
    expect(t.project).toBe(benchProjectId('lme', 'q1'));
    const want = new Map(formationSlots(Q1, SESS).slots.map(s => [s.context, dateToEpochMs(s.conversation.date ?? '')] as const));
    expect(t.map).toEqual(want);
    // 时刻值本身锚一个已知日期：正午 UTC，任何宿主时区下同值
    expect(dateToEpochMs('2024-03-05')).toBe(Date.parse('2024-03-05T12:00:00Z'));
  });
});

describe('assertRowTimeGeometry（改时刻前的闸）', () => {
  const t = planRowTime([Q1], SESS)[0]!;
  const ctx = [...t.map.keys()];

  it('会话节点一一对应（qa- 答题节点不算）→ 过', () => {
    expect(() => assertRowTimeGeometry([t], [...ctx, `${t.project}/qa-e-def`])).not.toThrow();
  });
  it('规划外的非 qa 节点 → 拒（库不是按这套槽位灌的）', () => {
    expect(() => assertRowTimeGeometry([t], [...ctx, `${t.project}/s-99-sx`])).toThrow(/规划外/);
  });
  it('槽位在库内缺席 → 拒（没灌 / 灌了一半）', () => {
    expect(() => assertRowTimeGeometry([t], ctx.slice(0, 1))).toThrow(/库内不存在/);
  });
});

describe('assertRowTimeConsistent（续跑一致性闸）', () => {
  it('空目录 / 旧记录（无字段 = replay）+ replay → 过', () => {
    expect(() => assertRowTimeConsistent({}, 'replay')).not.toThrow();
    expect(() => assertRowTimeConsistent({ a: { rowTime: undefined } }, 'replay')).not.toThrow();
  });
  it('source 轮续跑落回 replay → 拒（提示带 --row-time=source）', () => {
    expect(() => assertRowTimeConsistent({ a: { rowTime: 'source' } }, 'replay')).toThrow(/--row-time=source/);
  });
  it('replay 目录被 source 轮混入 → 拒（提示换 --tag）', () => {
    expect(() => assertRowTimeConsistent({ a: {}, b: { rowTime: 'source' } }, 'source')).toThrow(/--tag/);
  });
});

// ------------------------------------------------------------------ SQL 文本

describe('SQL 构造（纯文本）', () => {
  const targets = planRowTime([Q1], SESS);

  it('ensure：锁内建表（IF NOT EXISTS + NO DATA）、增量备份（NOT EXISTS）、改时刻（RETURNING 计数）', () => {
    const sql = sqlEnsure(targets);
    expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${BACKUP_TABLE} AS SELECT vb_id, ts FROM memories_verbatim WITH NO DATA`);
    expect(sql).toContain('pg_advisory_xact_lock');
    expect(sql).toMatch(/NOT EXISTS \(SELECT 1 FROM bench_vb_ts_backup/);
    expect(sql).toContain("'changed=' || count(*)");
    expect(sql).toContain('BEGIN;');
    expect(sql).toContain('COMMIT;');
  });
  it('ensure / reconcile：字符串里的单引号被转义（外部字符串不破 SQL）', () => {
    // 坐标函数（cleanSegment）本身会把 id 里的标点洗掉，这里手工造带引号的 context 直测 lit 的转义
    const nasty: RowTimeTarget = { qid: `q'x`, project: `/root/bench-lme-p'x`, map: new Map([[`/root/bench-lme-p'x/s-0-s'a`, 1709640000000]]) };
    const sql = sqlEnsure([nasty]);
    expect(sql).toContain(`'/root/bench-lme-p''x/s-0-s''a'`);
    expect(sql).not.toContain(`p'x/s-0-s'a`); // 原文（未转义）不得出现
  });
  it('reconcile：四段对账（≠ 规划值 | 未入备份 | 规划行 | 备份行）', () => {
    const sql = sqlReconcile(targets);
    expect(sql).toContain(`FROM ${BACKUP_TABLE}`);
    expect(sql.match(/\|\| '\|' \|\|/g)).toHaveLength(3);
  });
  it('revert：回填 + 残差闸（除零 → 整笔回滚）+ 删表同一事务（DROP 在 COMMIT 前）；残差 = 标量子查询直拼', () => {
    const sql = sqlRevert();
    expect(sql).toContain("'restored=' || count(*)");
    expect(sql).toContain("'diff=' || (SELECT count(*)");
    // 残差不许再包「外层 count 数子查询行数（恒 1）」的双计数形态
    expect(sql).not.toMatch(/count\(\*\) FROM \(SELECT count\(\*\)/);
    const dropAt = sql.indexOf(`DROP TABLE IF EXISTS ${BACKUP_TABLE}`);
    expect(dropAt).toBeGreaterThan(-1);
    expect(dropAt).toBeLessThan(sql.lastIndexOf('COMMIT;'));
  });
});

// ------------------------------------------------------------------ 开局 / 收尾决策

describe('beginRowTime / end（假库面 + 假租约）', () => {
  const targets = planRowTime([Q1], SESS);
  const ctxOf = (ts: RowTimeTarget[]) => ts.flatMap(x => [...x.map.keys()]);

  it('replay + 库为快照态 → 不碰库，只记日志；end 幂等', async () => {
    const lease = fakeLease([]);
    const store = fakeStore({ backupExists: async () => false });
    const logs: string[] = [];
    const h = await beginRowTime({ mode: 'replay', lease, store, targets, log: m => logs.push(m) });
    expect(logs.join('\n')).toMatch(/replay（缺省）/);
    expect(store.calls).toEqual(['backupExists']);
    await h.end();
    expect(store.calls).toEqual(['backupExists']); // replay 收尾不碰库
    expect(lease.closed).toBe(1);
    await h.end(); // 幂等
    expect(lease.closed).toBe(1);
  });

  it('replay + 库停在 source 态（上一轮没还原）→ 自动还原', async () => {
    const lease = fakeLease([]);
    const store = fakeStore({ backupExists: async () => true, revert: async () => 8122 });
    const logs: string[] = [];
    await beginRowTime({ mode: 'replay', lease, store, targets, log: m => logs.push(m) });
    expect(store.calls).toContain('revert');
    expect(logs.join('\n')).toMatch(/自动还原 8122 行/);
  });

  it('source → 几何闸 + 施加；收尾还原（自己是最后一个）；先标 ending 再探', async () => {
    const lease = fakeLease([]);
    const store = fakeStore({
      contextsUnder: async () => ctxOf(targets).concat([`${targets[0]!.project}/qa-e-def`]),
      ensure: async () => ({ changed: 61, planned: 61, backed: 61 }),
      backupExists: async () => true,
      revert: async () => 61,
    });
    const logs: string[] = [];
    const h = await beginRowTime({ mode: 'source', lease, store, targets, log: m => logs.push(m) });
    expect(store.calls).toEqual(['contextsUnder', 'ensure']);
    expect(logs.join('\n')).toMatch(/source 态 ✓/);
    await h.end();
    expect(store.calls).toEqual(['contextsUnder', 'ensure', 'backupExists', 'revert']);
    expect(logs.join('\n')).toMatch(/已还原到 replay 态（61 行/);
    expect(lease.endings).toBe(1);
  });

  it('source 收尾：还有在跑的 source 轮 → 还原交给最后退出的那个', async () => {
    const peers: RowTimePeer[] = []; // 开局互拒（见下两条）——同台轮只能在开局之后出现
    const lease = fakeLease(peers);
    const store = fakeStore({ contextsUnder: async () => ctxOf(targets), backupExists: async () => true });
    const logs: string[] = [];
    const h = await beginRowTime({ mode: 'source', lease, store, targets, log: m => logs.push(m) });
    peers.push(PEER({ mode: 'source', label: 'e-verb' }));
    await h.end();
    expect(store.calls).not.toContain('revert');
    expect(logs.join('\n')).toMatch(/还原交给最后退出的那个/);
    expect(lease.closed).toBe(1);
  });

  it('source 收尾：剩下的只是 ending 轮 → 自己还原（两个都在收尾不许双双撒手）', async () => {
    const peers: RowTimePeer[] = []; // 开局时无轮（ending 轮会挡开局，见下一条）
    const lease = fakeLease(peers);
    const store = fakeStore({ contextsUnder: async () => ctxOf(targets), backupExists: async () => true, revert: async () => 1 });
    const h = await beginRowTime({ mode: 'source', lease, store, targets });
    peers.push(PEER({ mode: 'source', phase: 'ending', label: 'e-verb' })); // 收尾时刻别的轮只剩 ending 态
    await h.end();
    expect(store.calls).toContain('revert');
  });

  it('在跑的轮（异态）→ 拒跑；租约已撤，不留幽灵', async () => {
    const lease = fakeLease([PEER({ mode: 'source', label: 'e-verb-ts' })]);
    const store = fakeStore();
    await expect(beginRowTime({ mode: 'replay', lease, store, targets })).rejects.toThrow(/--row-time=source/);
    expect(lease.closed).toBe(1);
    expect(store.calls).toEqual([]);
  });

  it('开局等收尾中的轮退出（等不到才往下走）', async () => {
    const peers: RowTimePeer[] = [PEER({ mode: 'replay', phase: 'ending', label: 'e-def-old' })];
    const lease = fakeLease(peers);
    const store = fakeStore({ backupExists: async () => false });
    setTimeout(() => { peers.length = 0; }, 300); // 300ms 后那轮撤租约
    const logs: string[] = [];
    await beginRowTime({ mode: 'replay', lease, store, targets, log: m => logs.push(m) });
    expect(logs.join('\n')).toMatch(/replay（缺省）/); // 等到消失后才开局
  });

  it('在跑的轮（同态）→ 同样拒跑（bench daemon 互踩，警告挡不住 quota-run 自动续跑的重叠）', async () => {
    const lease = fakeLease([PEER({ mode: 'replay', label: 'e-verb' })]);
    const store = fakeStore({ backupExists: async () => false });
    await expect(beginRowTime({ mode: 'replay', lease, store, targets })).rejects.toThrow(/同库已有 1 个 qa 轮在跑/);
    expect(lease.closed).toBe(1);
    expect(store.calls).toEqual([]);
  });

  it('source 施加抛错（对账不平）→ 传播，租约已撤', async () => {
    const lease = fakeLease([]);
    const store = fakeStore({
      contextsUnder: async () => ctxOf(targets),
      ensure: async () => { throw new Error('行时刻对账不平：3 行时刻 ≠ 规划值'); },
    });
    await expect(beginRowTime({ mode: 'source', lease, store, targets })).rejects.toThrow(/对账不平/);
    expect(lease.closed).toBe(1);
  });
});

// ------------------------------------------------------------------ 入口判别 + 真租约

describe('isProcessEntry', () => {
  it('vitest 下本文件不是进程入口 → false（import 驱动不跑 main 的机制面）', () => {
    expect(isProcessEntry(import.meta.url)).toBe(false);
  });
  it('argv[1] 与模块 URL 同一文件 → true（大小写差也认）；别的文件 → false', () => {
    const fake = path.resolve('fake-entry-check.ts');
    const url = pathToFileURL(fake).href;
    const old = process.argv[1];
    try {
      process.argv[1] = fake;
      expect(isProcessEntry(url)).toBe(true);
      expect(isProcessEntry(url.toUpperCase())).toBe(true);
      expect(isProcessEntry(url.toLowerCase())).toBe(true);
      expect(isProcessEntry(pathToFileURL(path.resolve('other.ts')).href)).toBe(false);
    } finally {
      process.argv[1] = old;
    }
  });
});

describe('acquireRowTimeLease（真命名管道；每测独占库名防串扰）', () => {
  it.skipIf(process.platform !== 'win32')('两个租约各占一槽、互相可见；markEnding 可见；close 后消失', async () => {
    const db = `rt-test-${Date.now()}`;
    const a = await acquireRowTimeLease(db, { mode: 'source', pid: process.pid, at: '2026-11-23T00:00:00Z', label: 'A' });
    const b = await acquireRowTimeLease(db, { mode: 'replay', pid: process.pid, at: '2026-11-23T00:00:00Z', label: 'B' });
    try {
      const seenByB = await b.peers();
      expect(seenByB.map(p => p.label)).toEqual(['A']);
      expect(seenByB[0]!.mode).toBe('source');
      a.markEnding();
      expect((await b.peers())[0]!.phase).toBe('ending');
      await a.close();
      expect(await b.peers()).toEqual([]);
      await a.close(); // 幂等
    } finally {
      await a.close().catch(() => {});
      await b.close().catch(() => {});
    }
  });
});
