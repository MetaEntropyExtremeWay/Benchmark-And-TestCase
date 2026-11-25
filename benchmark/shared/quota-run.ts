/**
 * 额度窗自动续跑包装（LLM 5 小时窗 / 周额度，429 报文带重置时间）。
 *
 * 为什么在 harness 层而不是各驱动里：断续语义对所有长跑面通用（formation 回放/排空、
 * qa 答题、判分），各驱动只需保证幂等可重入（formation 账本 done 跳过、qa
 * --skip-existing、judge 覆盖写），重试时机统一在这里判。
 *
 * 识别口径：
 *   - 命中「您的限额将在 <YYYY-MM-DD HH:MM:SS> 重置」（取最新一处）→ 睡到该时刻
 *     + buffer 再跑；
 *   - 无重置时间但命中可重试特征（429 / 限额 / 嵌入断层 / 排空超预算 / QUOTA / 未判）
 *     → 固定 poll 间隔再跑（额度窗内盲试，窗到自然过）；
 *   - 两者皆无 → 原样退出（真错误，交人处理）。
 * 上限：--max-attempts（默认 40）；重置点距今 > 8 天视为异常退出（周额度也在界内）。
 *
 * 用法（benchmark 根；命令跟在 -- 之后原样执行，-- 可省——本壳链 npx/tsx 会剥它，
 * 解析面两个形态等价：首个非本件选项的 token 即命令起点）：
 *   npx tsx shared/quota-run.ts [--buffer-sec=120] [--max-attempts=40] [--poll-min=20] -- <命令>
 * 例：
 *   npx tsx shared/quota-run.ts -- npx tsx lmg/formation.ts --dataset=lme --ids=frozen/lme-126.json --jobs=4 --verify
 *   npx tsx shared/quota-run.ts -- npx tsx lmg/qa.ts --dataset=lme --arm=default --ids=frozen/lme-126.json --skip-existing
 */
import { spawn } from 'node:child_process';

/** 额度重置时间提取（zhipu 网关 429 报文内嵌；本地时间无时区后缀）。 */
const RESET_RE = /您的限额将在 (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) 重置/g;
/** 可重试特征（无重置时间时的兜底判据——固定间隔盲试到窗过）。 */
const RETRYABLE_RE = /429|限额|rate.?limit|quota|嵌入断层|排空超预算|QUOTA|未判/i;
/** 输出环形缓冲上限（只留尾部——识别特征都在最近输出里，防多日运行无限增长）。 */
const BUFFER_CAP = 400_000;

export interface QuotaRunOpts {
  bufferSec: number;
  maxAttempts: number;
  pollMin: number;
  cmd: string[];
}

export function parseQuotaRunArgs(argv: string[]): QuotaRunOpts {
  let bufferSec = 120;
  let maxAttempts = 40;
  let pollMin = 20;
  const cmd: string[] = [];
  let seenSep = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (seenSep) { cmd.push(a); continue; }
    if (a === '--') { seenSep = true; continue; }
    const m = /^--(buffer-sec|max-attempts|poll-min)=(\d+(?:\.\d+)?)$/.exec(a);
    if (!m) {
      if (a.startsWith('--')) throw new Error(`参数无效：${a}（仅 --buffer-sec / --max-attempts / --poll-min，命令跟在 -- 之后）`);
      // 分隔符可省略：本壳链（npx/tsx）会剥首个 --，首个非选项 token 即命令起点
      // （显式 -- 仍支持）——两个形态解析同果；破折号开头仍抛（本件选项手误面）。
      cmd.push(...argv.slice(i));
      break;
    }
    const v = Number(m[2]);
    if (v <= 0) throw new Error(`参数须为正数：${a}`);
    if (m[1] === 'buffer-sec') bufferSec = v;
    else if (m[1] === 'max-attempts') maxAttempts = Math.floor(v);
    else pollMin = v;
  }
  if (cmd.length === 0) throw new Error('缺命令：quota-run.ts [选项] -- <命令>');
  return { bufferSec, maxAttempts, pollMin, cmd };
}

/** 文本 → 最新重置时刻（epoch ms）；无匹配返 null。多报文取最新（同一窗内等值，跨窗取后见）。 */
export function latestResetEpochMs(text: string): number | null {
  let latest: number | null = null;
  for (const m of text.matchAll(RESET_RE)) {
    const t = new Date(m[1]!.replace(' ', 'T')).getTime();
    if (Number.isFinite(t) && (latest === null || t > latest)) latest = t;
  }
  return latest;
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const fmtWait = (ms: number): string => {
  const min = Math.round(ms / 60000);
  return min >= 60 ? `${Math.floor(min / 60)}h${String(min % 60).padStart(2, '0')}m` : `${min}m`;
};
const now = (): string => new Date().toTimeString().slice(0, 8);

/** 跑一轮：流式透传 + 尾部环形缓冲；返回退出码（spawn 失败 = null）。 */
async function runOnce(cmd: string[], buffer: { text: string }): Promise<number | null> {
  return await new Promise(resolve => {
    const child = spawn(cmd.join(' '), { shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const onChunk = (d: Buffer) => {
      const s = d.toString();
      process.stdout.write(s);
      buffer.text = (buffer.text + s).slice(-BUFFER_CAP);
    };
    child.stdout.on('data', onChunk);
    child.stderr.on('data', onChunk);
    child.on('close', code => resolve(code));
    child.on('error', () => resolve(null));
  });
}

async function main(): Promise<void> {
  const opts = parseQuotaRunArgs(process.argv.slice(2));
  console.log(`[quota-run ${now()}] 命令：${opts.cmd.join(' ')}（buffer=${opts.bufferSec}s，max-attempts=${opts.maxAttempts}，poll=${opts.pollMin}min）`);
  const buffer = { text: '' };
  for (let attempt = 1; ; attempt++) {
    console.log(`\n[quota-run ${now()}] ===== 第 ${attempt} 轮 =====`);
    const code = await runOnce(opts.cmd, buffer);
    if (code === 0) {
      console.log(`\n[quota-run ${now()}] 命令成功退出（${attempt} 轮）`);
      process.exit(0);
    }
    if (code === null) {
      console.error(`\n[quota-run ${now()}] 子进程 spawn 失败——退出`);
      process.exit(1);
    }
    if (attempt >= opts.maxAttempts) {
      console.error(`\n[quota-run ${now()}] 已达重试上限 ${opts.maxAttempts}，退出码 ${code} 透传`);
      process.exit(code);
    }
    const reset = latestResetEpochMs(buffer.text);
    let waitMs: number;
    if (reset !== null) {
      waitMs = reset + opts.bufferSec * 1000 - Date.now();
      if (waitMs > 8 * 24 * 3600 * 1000) {
        console.error(`\n[quota-run ${now()}] 重置点距今 > 8 天（异常），退出码 ${code} 透传`);
        process.exit(code);
      }
      if (waitMs < 0) waitMs = opts.bufferSec * 1000; // 报文滞后于重置点：只给 buffer 即试
      console.log(`\n[quota-run ${now()}] 第 ${attempt} 轮退出码 ${code}：额度重置于 ${new Date(reset).toLocaleString('sv-SE')}，睡 ${fmtWait(waitMs)} 后重跑`);
    } else if (RETRYABLE_RE.test(buffer.text)) {
      waitMs = opts.pollMin * 60 * 1000;
      console.log(`\n[quota-run ${now()}] 第 ${attempt} 轮退出码 ${code}：命中可重试特征但无重置时间——${opts.pollMin}min 后盲试（窗到自然过）`);
    } else {
      console.error(`\n[quota-run ${now()}] 第 ${attempt} 轮退出码 ${code}：无可重试特征（真错误），透传退出`);
      process.exit(code);
    }
    await sleep(waitMs);
  }
}

if (!process.env.VITEST) {
  main().catch(err => {
    console.error(String((err as Error).stack ?? err));
    process.exit(1);
  });
}
