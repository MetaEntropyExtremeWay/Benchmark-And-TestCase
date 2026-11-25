/**
 * mc 检索直测线 · prepare：题集 pack → 零 LLM 灌库（一条 record 一条）→ 串台验收。
 * 用法：npx tsx mc/prepare.ts --run <runId> [--dataset lme|locomo] [--limit N] [--skip-ingest]
 *       [--types cat1,cat2]（categoryLabel 白名单）
 *
 * 座标契约：每题 cwd（armCwd）经 slug 映射落 mem context /root/<slug>
 * （coords.ts 单源）——本模块把该题 scope 的 records 灌进同一条坐标，检索直测侧
 * （recall.ts）经同一公式对上（对不上 = 直测看不见库）。
 * 灌完：等 outbox 排空（向量化异步）→ 串台验收（检索命中的 gold 单元键必须全部
 * 落在该题 scopeKeys 内，reinforce=false 不污染排序）→ manifest 落 run 树。
 * 幂等：ensureContext 幂等 + upsert 按 (context,kind,name) 替换，重跑安全。
 * 粒度注意：灌库粒度改过后，勿复用旧 runId 的 context（残留旧粒度条目与旧粒度
 * name 不重合，upsert 不会清掉它们）——换新 runId 重灌。
 */
import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { loadPack, type PackQuestion } from '../shared/pack.ts';
import { getAdapter } from '../datasets/registry.ts';
import { buildOps } from './ingest.ts';
import { MemClient } from '../shared/mem.ts';
import { retryOnTransientLock } from '../shared/retry.ts';
import { loadHarnessEnv } from '../shared/config.ts';
import { parseArgs } from '../shared/args.ts';
import { armCwd, runDirFor, contextIdForCwd } from '../shared/coords.ts';

interface PreparedQuestion {
  qid: string;
  cwd: string;
  contextId: string;
  recordCount: number;
  opCount: number;
  /** 串台验收：检索命中（topk 10）的 gold 单元键全部落该题 scopeKeys 内 */
  verify: { hits: number; distinctUnits: number; inScope: boolean };
}

interface PrepareManifest {
  kind: 'prepare';
  runId: string;
  dataset: string;
  /** 题数上限（null = pack 全量） */
  limit: number | null;
  /** --types 过滤（categoryLabel 白名单；null = 不过滤） */
  types: string[] | null;
  agentName: string;
  memUrl: string;
  /** 入库粒度（ingest.buildOps 的产出形态，版本可比性判据之一） */
  granularity: 'per-record';
  embedProvider: string | null;
  /** false = --skip-ingest 重入（只等排空 + 验收 + 补写 manifest，库未重灌） */
  ingested: boolean;
  startedAt: string;
  finishedAt: string;
  questions: PreparedQuestion[];
}

async function main(): Promise<void> {
  const argv = parseArgs(process.argv.slice(2));
  const dataset = argv.dataset === 'locomo' ? 'locomo' : 'lme';
  const adapter = getAdapter(dataset);
  const limit = argv.limit ? Math.max(1, Number(argv.limit) || 1) : null;
  const runId = argv.run ?? `mc-prepare-${new Date().toISOString().slice(0, 10)}`;
  const env = loadHarnessEnv(dataset as 'lme' | 'locomo');
  const skipIngest = argv['skip-ingest'] === 'true';
  const types = argv.types ? argv.types.split(',').map(s => s.trim()).filter(Boolean) : null;

  const pack = loadPack(env.dataDir, dataset);
  const questions = pack.questions
    .slice(0, limit ?? Infinity)
    .filter(q => (types ? types.includes(q.categoryLabel) : true));
  if (questions.length === 0) throw new Error('过滤后零题——检查 --limit / --types（categoryLabel 名）');

  const client = new MemClient({ baseUrl: env.memUrl });
  let health;
  try {
    health = await client.health();
  } catch {
    throw new Error(`mc 服务不可达（${env.memUrl}）——先拉起 bench 实例：shared\\scripts\\mem-bench-app.ps1 start -Dataset ${dataset}`);
  }
  if (health.status !== 'UP') {
    throw new Error(`mc 服务状态 ${health.status}（embed=${health.embedStatus}），先处理服务再灌库`);
  }

  console.log(
    `prepare ${runId}：${dataset} ${questions.length} 题（pack records ${pack.records.length} 条），` +
    `粒度一条 record 一条，agent=${env.agentName}，embed=${health.embedProvider ?? 'stub'}` +
    (skipIngest ? '，--skip-ingest（不重灌，只等排空 + 验收 + 补 manifest）' : ''),
  );

  const startedAt = new Date().toISOString();
  const prepared: PreparedQuestion[] = [];
  for (const q of questions) {
    const cwd = armCwd(env.stateDir, runId, 'a', q.id);
    const contextId = contextIdForCwd(cwd);
    const qRecords = adapter.questionRecords(q, pack.records);
    if (qRecords.length === 0) throw new Error(`[${q.id}] scope 内零 record（adapter.questionRecords 过滤过严或 pack 键系不一致）`);
    const { ops } = buildOps(qRecords, contextId);
    if (!skipIngest) {
      await client.ensureContext(contextId, 'project', contextId.split('/').pop() as string);
      await client.batchUpsert(ops);
    }
    prepared.push({
      qid: q.id, cwd, contextId,
      recordCount: qRecords.length, opCount: ops.length,
      verify: { hits: 0, distinctUnits: 0, inScope: true },
    });
    console.log(`  [${q.id}] ${qRecords.length} records → ${ops.length} ops → ${contextId}`);
  }

  await client.waitForOutboxDrain(env.drainMs, msg => console.log(`  ${msg}`));

  // 串台验收：每题在其 context 检索，命中的 gold 单元键（adapter.hitKey）必须全部
  // 落在该题 scopeKeys 内（兄弟隔离 + 零跨题）
  console.log('串台验收（题面原句检索 topk10，reinforce=false）…');
  let leaks = 0;
  for (const p of prepared) {
    const q = questions.find(x => x.id === p.qid) as PackQuestion;
    const scopeSet = new Set(q.scopeKeys);
    const { hits, degraded } = await client.search(q.question, p.contextId, 10, { reinforce: false });
    const offenders: string[] = [];
    const units = new Set<string>();
    for (const h of hits) {
      const unit = adapter.hitKey(h);
      if (!unit || !scopeSet.has(unit)) offenders.push(unit || h.name);
      else units.add(unit);
    }
    const inScope = offenders.length === 0;
    p.verify = { hits: hits.length, distinctUnits: units.size, inScope };
    if (degraded) console.warn(`  [${p.qid}] 检索降级（degraded）——验收读数仅供参考`);
    if (!inScope) {
      leaks++;
      console.error(`  [${p.qid}] 越界命中：${offenders.join(', ')}`);
    }
  }

  const manifest: PrepareManifest = {
    kind: 'prepare', runId, dataset, limit, types,
    agentName: env.agentName, memUrl: env.memUrl, granularity: 'per-record',
    embedProvider: health.embedProvider, ingested: !skipIngest,
    startedAt, finishedAt: new Date().toISOString(),
    questions: prepared,
  };
  const runDir = runDirFor(env.stateDir, runId);
  mkdirSync(runDir, { recursive: true });
  const file = path.join(runDir, 'prepare.json');
  const tmp = path.join(runDir, 'prepare.json.tmp');
  writeFileSync(tmp, JSON.stringify(manifest, null, 2), 'utf8');
  retryOnTransientLock(() => renameSync(tmp, file));

  const totalOps = prepared.reduce((s, p) => s + p.opCount, 0);
  console.log(
    `\nprepare ${runId} 完成：${prepared.length} 题 / ${totalOps} ops，manifest → ${path.relative(process.cwd(), file)}`,
  );
  if (leaks > 0) {
    console.error(`串台验收未过：${leaks} 题存在越界命中（隔离机制失效，直测读数不可用）`);
    process.exit(1);
  }
  console.log('串台验收通过：全部命中落各自题域内');
}

main().catch(err => {
  console.error(String(err));
  process.exit(1);
});
