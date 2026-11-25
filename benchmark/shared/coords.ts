/**
 * 座标契约单源：run 树路径公式 + cwd→mem context 推导（slug）。
 *
 * 「灌库与答题同一条坐标」的命脉：mc 检索直测线（prepare / recall）与 lmg 产品链
 * 驱动（formation / qa）都从本件 import——公式只此一处，两侧共用防漂移。
 * 注意：同臂重复跑 = 换 runId（路径含 runId → 新 context，天然一次性），
 * 不需要 #r1/#r2 后缀机制。
 *
 * 坐标形态 = 产品三层 /root/<projectid>/<sessionid>（与产品缺省池 /root/main 同形）。
 * project = 工作场景 slug（cwd 推断，整条 cwd 路径进哈希：runId+qid 在路径里 →
 * 跨 run 天然不撞）；宿主身份不进 project——宿主身份放 session 节点名（lmg 宿主侧
 * s-<stamp>；产品 daemon 语义为 s-ag-<agent>-<slug>）。本公式只服务 bench 本地池。
 */
import path from 'node:path';
import { createHash } from 'node:crypto';

/** state/<dataset>/<runId>/data/cwd/<arm>/<qid> —— 每题独立临时 cwd（机器面，随 data 落层）。 */
export function armCwd(stateDir: string, runId: string, arm: string, qid: string): string {
  return path.join(stateDir, runId, 'data', 'cwd', arm, qid);
}

/** state/<dataset>/<runId>/data —— 机器产物目录（prepare.json 等）。 */
export function runDirFor(stateDir: string, runId: string): string {
  return path.join(stateDir, runId, 'data');
}

/** 路径规范化：分隔符统一 /（折叠重复）、去尾斜杠、整体小写。 */
export function normalizeDir(dir: string): string {
  return dir
    .trim()
    .replace(/[\\/]+/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();
}

/** 段净化：小写 + 收敛到 [a-z0-9-]（非法字符段折叠为单 -、去首尾 -、截 32）。 */
export function cleanSegment(seg: string): string {
  return seg
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
}

/** 目录 → slug：`<可读名>-<规范路径哈希8>`；可读名净化为空（纯 CJK 目录名）→ 纯哈希。 */
export function slugFor(dir: string): string {
  const norm = normalizeDir(dir);
  const hash = createHash('sha256').update(norm).digest('hex').slice(0, 8);
  const name = cleanSegment(norm.slice(norm.lastIndexOf('/') + 1));
  return name ? `${name}-${hash}` : hash;
}

/** cwd → bench 池 project 坐标（prepare 灌库 / replay 驱动必须一致）：
 *  /root/<slug>——project = 工作场景单段直挂 /root（与产品 cwdProjectId 同公式），
 *  会话由宿主生成（exo s-<stamp> / 外部 agent s-ag-<agent>-<slug>）。 */
export function contextIdForCwd(cwd: string): string {
  return `/root/${slugFor(cwd)}`;
}

// ------------------------------------------------------------------ lmg 链（chain）几何
//
// lmg 产品链 formation / 臂答题几何（与上文 mc 直测公式并存、互不复用——mc 线 runId
// 进 project slug、prepare 幂等重入；chain 坐标按数据源拓扑定、formation 幂等重入同一库）。
// 隔离由几何承载：每题一个 project = 一个「用户」记忆域，跨题零串台；跨会话可见性走
// 服务端读窗（verbatim scope 配置）+ 晋升通道，不靠几何拆。
//
// session 段名约定：formation 段 s-<i>-<源sid>（i = 题内时序 0 起）——s- 前缀是
// 产品侧 parentProjectOf 剥段正则（\/[sd]-）的形状要求，收尾回放过滤按它剥 project；
// 服务端晋升锚走 contexts 表父链，不受段名形状影响，但两头一致最稳。答题段
// qa-<arm> 不收尾（无晋升面），不进剥段正则无碍。

/** 段净化：收敛到 [a-z0-9-]、折叠重复 -、去首尾 -、截 80（qid/ssid 保唯一为主，
 *  80 上限防病态长 id；与 cleanSegment 同法不同限——32 会截短 LME qid 致撞名）。 */
export function benchSegment(seg: string): string {
  return seg
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/** 链 project 坐标：/root/bench-<dataset>-<key>（每题一池——数据集无关，key = 题 id）。 */
export function benchProjectId(dataset: string, key: string): string {
  const seg = benchSegment(`bench-${dataset}-${key}`);
  if (!seg) throw new Error(`bench project 段净化后为空（dataset=${dataset} key=${key}）`);
  return `/root/${seg}`;
}

/** 链 formation session 坐标：<project>/s-<i>-<源sid>（题内时序第 i 个源会话回放）。 */
export function benchFormationSession(projectId: string, index: number, sid: string): string {
  return `${projectId}/s-${index}-${benchSegment(sid)}`;
}

/** 链答题 session 坐标：<project>/qa-<arm>（每臂新开；不收尾 = 无晋升面）。 */
export function qaSession(projectId: string, arm: string): string {
  return `${projectId}/qa-${benchSegment(arm)}`;
}

/** 链 run 树：<stateDir>/chain/<runId>（进度账本 / stdout / manifest 落这里；
 *  库内容本身在 PG，与 run 树无关）。 */
export function chainRunDir(stateDir: string, runId: string): string {
  return path.join(stateDir, 'chain', runId);
}
