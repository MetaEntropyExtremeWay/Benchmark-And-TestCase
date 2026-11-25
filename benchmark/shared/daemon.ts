/**
 * lmg 链驱动共用的 bench daemon 起/停（formation 与 qa 答题共用，差异面只有收尾
 * worker 开关：formation 开〔晋升评估执行体〕、答题关〔跨臂污染三重控制之一——
 * 答题期 worker 不得消费/晋升〕）。sched kernels 硬校验 ≥1 不可关（daemon 拒启 0）
 * ——钉 1 即产品形态；链线库无任务时内核空转无写入面。
 *
 * LLM 配置继承 lmg 仓 exo 包的 .env 文件（daemon cwd=packages/daemon、--env-file=../exo/.env）
 * ——收尾评估模型与交互同源，产品形态。
 *
 * 收尾消费节奏钉扎（worker on 面）：内核缺省 1 路 × 30s 轮询 = 吞吐硬顶 2 事件
 * /min，纯节拍器上限与 LLM 无关——万级槽位 formation 的收尾积压按此排空要 40+h。
 * bench 钉 8 路 × 5s（分片 claim：同 project 恒同片，评估串行防裂域；跨片并行，
 * 服务端分片面 mc 已备）。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { lmgRoot } from './config.ts';
import { sleep } from './mem.ts';

const EXO_ROOT = lmgRoot();
export const EXO_DIR = path.join(EXO_ROOT, 'packages', 'exo');
const DAEMON_DIR = path.join(EXO_ROOT, 'packages', 'daemon');
const TSX = path.join(EXO_ROOT, 'node_modules', '.bin', 'tsx.cmd'); // shell:true 形态（ingest.ts 同款）

interface DaemonHealth {
  app?: string;
  ready?: boolean;
  pid?: number;
}

export async function chainDaemonHealth(port: number): Promise<DaemonHealth | null> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
    return (await r.json()) as DaemonHealth;
  } catch {
    return null;
  }
}

export async function shutdownChainDaemon(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/shutdown`, { method: 'POST', signal: AbortSignal.timeout(5000) });
  } catch { /* 已死也算停了 */ }
  for (let i = 0; i < 15; i++) {
    if (!(await chainDaemonHealth(port))) return true;
    await sleep(400);
  }
  return false;
}

/** 起 bench daemon。陈旧 daemon 一律重启（worker 态不可考古，重启保确定）。 */
export async function ensureChainDaemon(
  memUrl: string,
  port: number,
  opts: { closeoutWorker: boolean; closeoutWorkers?: number; closeoutIntervalMs?: number },
  log: (msg: string) => void,
): Promise<void> {
  const existing = await chainDaemonHealth(port);
  if (existing) {
    if (existing.app !== 'lmg-daemon') {
      throw new Error(`端口 ${port} 被 daemon 以外的服务占用——释放端口或设 BENCH_LMG_DAEMON_PORT`);
    }
    log(`heal：关停陈旧 daemon（pid ${existing.pid}）——worker 态不可考古，重启保确定`);
    if (!(await shutdownB2Daemon(port))) {
      throw new Error(`陈旧 daemon :${port} 关不掉——手动 POST /shutdown 或杀 pid ${existing.pid}`);
    }
  }
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of ['LMG_DAEMON_PORT', 'LMG_MEM_BACKEND', 'LMG_MEM_API', 'LMG_MEM_TOKEN', 'LMG_MEM_PROJECT', 'LMG_MEM_CONTEXT']) {
    delete env[key];
  }
  Object.assign(env, {
    LMG_DAEMON_PORT: String(port),
    LMG_MEM_BACKEND: 'remote',
    LMG_MEM_API: memUrl,
    LMG_MEM_TOKEN: '',
    LMG_MEM_PROJECT: '/root/bench-chain-driver', // daemon 自身身份面（d-stamp 落此，不进题池）
    LMG_CLOSEOUT_WORKER: opts.closeoutWorker ? 'on' : 'off',
    // 消费节奏钉扎（worker on 才有意义；off 面留内核缺省）——见文件头
    ...(opts.closeoutWorker ? {
      LMG_CLOSEOUT_WORKERS: String(opts.closeoutWorkers ?? 8),
      LMG_CLOSEOUT_WORKER_INTERVAL_MS: String(opts.closeoutIntervalMs ?? 5_000),
    } : {}),
    LMG_SCHED_KERNELS: '1', // 硬校验 ≥1；库无任务 → 空转无写入
    LMG_LOG: '0',
  });
  const cmdArgs: string[] = [];
  if (existsSync(path.join(EXO_DIR, '.env'))) cmdArgs.push('--env-file=../exo/.env');
  cmdArgs.push('src/main.ts');
  const child = spawn(TSX, cmdArgs, { cwd: DAEMON_DIR, env, windowsHide: true, shell: true });
  const stderr: string[] = [];
  child.stderr?.on('data', d => stderr.push(String(d)));
  const deadline = Date.now() + 40_000;
  let health: DaemonHealth | null = null;
  while (Date.now() < deadline) {
    health = await chainDaemonHealth(port);
    if (health?.app === 'lmg-daemon' && health.ready) break;
    if (child.exitCode !== null) {
      throw new Error(`daemon 早退（code ${child.exitCode}）：${stderr.join('').slice(-1500)}`);
    }
    await sleep(400);
  }
  if (!(health?.app === 'lmg-daemon' && health.ready)) {
    await shutdownB2Daemon(port);
    child.kill();
    throw new Error(`daemon 40s 未就绪：${stderr.join('').slice(-1500)}`);
  }
  log(`daemon :${port} 就绪（pid ${health.pid}，closeout worker=${opts.closeoutWorker ? `on ${opts.closeoutWorkers ?? 8}路×${Math.round((opts.closeoutIntervalMs ?? 5_000) / 1000)}s` : 'off'}）→ mem ${memUrl}`);
}
