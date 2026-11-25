/**
 * mc 直测线 clean：域内清场——启动前整理本数据集域（output/<dataset>/），别家数据不碰。
 * 用法：npx tsx mc/clean.ts --dataset=lme|locomo [--reset-db] [--apply]
 * 两层清场：
 *   ① run 树 + report-*.md：恒清（full 任务产物取代旧任务；人读结论在 report/分析档里）；
 *   ② bench 库 lmg_mem_bench_<dataset>：按 ingest 指纹（数据源 + 灌库链代码，纯决策层在
 *      clean-core.ts）比对——一致保留、变化/无记录/--reset-db 才重置。重置由
 *      shared\scripts\mem-bench-app.ps1 reset 承担（停实例 → dropdb → createdb → 起实例，Flyway 自迁）。
 * 缺省 dry-run（只报计划不动任何东西）；--apply 才落刀。指纹落域根 .ingest-fp（清场不碰 dotfile）。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { loadHarnessEnv, benchRoot } from '../shared/config.ts';
import { parseArgs } from '../shared/args.ts';
import { ingestFpInputs, hashInputs, readStoredFp, planWipe, dbResetDecision } from './clean-core.ts';

function main(): void {
  const argv = parseArgs(process.argv.slice(2));
  const dataset = argv.dataset === 'locomo' ? 'locomo' as const : 'lme' as const;
  const forceReset = argv['reset-db'] === 'true';
  const apply = argv.apply === 'true';
  const env = loadHarnessEnv(dataset);

  // 当前指纹：数据源 + 灌库链代码逐文件 sha256 再复合（文件缺失显式报错，不静默跳过）
  const inputs = ingestFpInputs(dataset).map(rel => {
    const abs = path.join(benchRoot, rel);
    if (!existsSync(abs)) throw new Error(`指纹输入缺失：${rel}（路径动过？同步改 clean-core.ts 清单）`);
    return { file: rel, sha256: createHash('sha256').update(readFileSync(abs)).digest('hex') };
  });
  const currentFp = hashInputs(inputs);

  const fpFile = path.join(env.stateDir, '.ingest-fp');
  const stored = readStoredFp(fpFile);
  const decision = dbResetDecision(stored?.fp ?? null, currentFp, forceReset);

  const wipe = existsSync(env.stateDir)
    ? planWipe(readdirSync(env.stateDir, { withFileTypes: true }).map(d => ({ name: d.name, isDir: d.isDirectory() })))
    : [];

  const dbName = `lmg_mem_bench_${dataset}`;
  console.log(`clean ${dataset}：域 ${path.relative(benchRoot, env.stateDir)}\\`);
  console.log(`  清单（${wipe.length} 项）：${wipe.length ? wipe.join('、') : '（空，无可清）'}`);
  console.log(`  库 ${dbName}：${decision.reset ? '重置' : '保留'}——${decision.reason}`);
  console.log(`  指纹 ${currentFp.slice(0, 12)}…（输入 ${inputs.length} 个文件；存量指纹 ${stored ? stored.fp.slice(0, 12) + '…' : '无'}）`);

  if (!apply) {
    console.log('（dry-run——未动任何东西；确认后加 --apply 执行）');
    return;
  }

  mkdirSync(env.stateDir, { recursive: true });
  for (const name of wipe) {
    rmSync(path.join(env.stateDir, name), { recursive: true, force: true });
  }
  if (wipe.length) console.log(`已清 ${wipe.length} 项`);
  writeFileSync(fpFile, JSON.stringify({ fp: currentFp, createdAt: new Date().toISOString(), inputs }, null, 2) + '\n', 'utf8');
  console.log(`指纹已落 ${path.relative(benchRoot, fpFile)}`);

  if (decision.reset) {
    const r = spawnSync(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(benchRoot, 'shared', 'scripts', 'mem-bench-app.ps1'), 'reset', '-Dataset', dataset],
      { stdio: 'inherit' },
    );
    if (r.status !== 0) {
      throw new Error(`库重置失败（mem-bench-app.ps1 reset 退出码 ${r.status ?? 'null'}）——域内文件已清、指纹已落，库状态未知，处理后再跑`);
    }
  }
  console.log(`clean ${dataset} 完成`);
}

main();
