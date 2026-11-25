/**
 * mc（记忆服务）HTTP 客户端（只覆盖跑分用到的面）：
 * - contexts 建（幂等 ensure）；doc 批量写（逐条 doc-save / skill-save upsert）
 * - search（q / context_id / topk / min_score 门槛前候选 / reinforce=false 不强化 /
 *   clusters 同团附带配额——响应行带 meta 与诊断字段 evidence / matched / degraded）
 * - health（outbox pending / embed 状态 / verbatim 队列分量——灌库排空判据）
 * - verbatim 批量写（原文层）与深检索（deep retrieval 面）
 * 端点与字段语义的权威定义在 mc 仓文档；要用另一套记忆服务跑 harness，兼容实现需
 * 覆盖以上调用面。
 */
import type { SearchHit } from './types.ts';

export interface MemClientOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
}

export interface UpsertOp {
  context_id: string;
  kind: 'is' | 'defn' | 'funcall';
  name?: string;
  doc?: string;
  value?: string;
  meta?: Record<string, unknown>;
}

/** 同团附带块（mem 0.9.77+ search 响应；verbatim 面 0.9.79+ 同形）：cluster = meta.engram 团号，docs = 同团成员原文。 */
export interface ClusterAttach {
  cluster: string;
  docs: string[];
}

/** 原文层命中行（/verbatim/search 与 /verbatim/recent 共形）：text 全文不截断（截断归客户端）。 */
export interface VerbatimHit {
  vb_id: string;
  context_id: string;
  seq: number;
  ts?: number;
  turn_role: 'user' | 'assistant';
  text: string;
  meta?: Record<string, unknown> | null;
  score?: number;
  matched?: number;
}

/** 原文层写行（POST /verbatim/bulk 的 row 形）。 */
export interface VerbatimWriteRow {
  turn_role: 'user' | 'assistant';
  text: string;
  ts?: number;
  meta?: Record<string, unknown>;
}

export interface HealthReport {
  status: string;
  outboxPending: number;
  outboxDead: number;
  verbatimPending: number;
  verbatimDead: number;
  embedProvider: string | null;
  embedStatus: string | null;
}

export class MemError extends Error {
  constructor(message: string, readonly status: number, readonly body: string) {
    super(`${message} (HTTP ${status}): ${body.slice(0, 300)}`);
  }
}

export class MemClient {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: MemClientOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await this.fetchImpl(this.base + path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new MemError(`${method} ${path} failed`, res.status, text);
    }
    return text ? JSON.parse(text) : {};
  }

  /**
   * 建链（幂等）：逐级 ensure（服务端同 parent+layer 重建返回 200 既有节点；
   * 409 只在异形时出现，照抛）。/root 已种子，从其直接子级建到目标。
   */
  async ensureContext(contextId: string, layer: 'project' | 'session', label: string): Promise<void> {
    const parts = contextId.split('/').filter(Boolean); // ['root','bench','lme-...']
    if (parts[0] !== 'root' || parts.length < 2) {
      throw new Error(`bench 上下文必须挂在 /root 下: ${contextId}`);
    }
    let parentId = '/root';
    for (let i = 1; i < parts.length; i++) {
      const ctx = '/' + parts.slice(0, i + 1).join('/');
      await this.request('POST', '/contexts', { context_id: ctx, parent_id: parentId, layer, label });
      parentId = ctx;
    }
  }

  /**
   * 建单段子节点（父须已在）：ensureContext 逐级建链时所有段共用末段 layer——
   * 二层链（project→session）会把 project 段按 session 重发撞异形 409。已建好
   * 父链、只补末段时用本件。
   */
  async ensureChildContext(contextId: string, parentId: string, layer: 'project' | 'session', label: string): Promise<void> {
    await this.request('POST', '/contexts', { context_id: contextId, parent_id: parentId, layer, label });
  }

  /**
   * 批量写：逐条 doc-save（kind=is）/ skill-save（其余），upsert 语义与 batch 时代
   * 相同——/memories/batch HTTP 面 0.9.83 退役。逐条失败即抛（错误带序号与名称）；
   * 已写条是幂等 upsert，修因后整段重放安全。进度回调按条计。
   */
  async batchUpsert(ops: UpsertOp[], onProgress?: (done: number, total: number) => void): Promise<void> {
    const total = ops.length;
    for (let i = 0; i < total; i++) {
      const o = ops[i];
      try {
        if (o.kind === 'is') {
          await this.request('POST', '/memories/doc-save', {
            context_id: o.context_id,
            ...(o.doc !== undefined ? { doc: o.doc } : {}),
            ...(o.name !== undefined ? { name: o.name } : {}),
            ...(o.meta !== undefined ? { meta: o.meta } : {}),
          });
        } else {
          await this.request('POST', '/memories/skill-save', {
            context_id: o.context_id,
            kind: o.kind,
            ...(o.name !== undefined ? { name: o.name } : {}),
            ...(o.doc !== undefined ? { doc: o.doc } : {}),
            ...(o.value !== undefined ? { value: o.value } : {}),
            ...(o.meta !== undefined ? { meta: o.meta } : {}),
          });
        }
      } catch (e) {
        const label = o.name ?? (o.doc !== undefined ? o.doc.slice(0, 40) : o.kind);
        throw new Error(`batch upsert 第 ${i} 条失败（${o.context_id} ${label}）: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (i % 100 === 99 || i === total - 1) onProgress?.(Math.min(i + 1, total), total);
    }
  }

  /**
   * reinforce=false：诊断/对照读（服务端跳过命中强化），同库多轮对照不互相污染排序。
   * query 传数组 = 多查询（服务端 best-max 融合，`?q=a&q=b`，上限 8 条、空串 400）。
   * minScore：覆盖服务端准入门槛（服务端诊断口；调 0 = 拿门槛前候选，
   * 命中行随带 evidence/matched 供本地复算真实门槛效果——常态响应不带）。
   * clusters：同团附带块配额（缺省 0=关——语义聚团写入形态的消费方显式开启）。
   * 附带块与命中同响应返回，纯呈现层不进准入不强化。
   */
  async search(
    query: string | string[],
    contextId: string,
    topk: number,
    opts?: { reinforce?: boolean; minScore?: number; clusters?: number },
  ): Promise<{ hits: SearchHit[]; degraded: boolean; clusters: ClusterAttach[] }> {
    const qs = (Array.isArray(query) ? query : [query])
      .map(q => q.trim())
      .filter(q => q.length > 0)
      .slice(0, 8)
      .map(q => `q=${encodeURIComponent(q)}`)
      .join('&');
    const res = (await this.request(
      'GET',
      `/memories/search?${qs}&context_id=${encodeURIComponent(contextId)}&topk=${topk}`
      + (opts?.reinforce === false ? '&reinforce=false' : '')
      + (opts?.minScore !== undefined ? `&min_score=${opts.minScore}` : '')
      + (opts?.clusters !== undefined ? `&clusters=${opts.clusters}` : ''),
    )) as { results: SearchHit[]; degraded: unknown; clusters?: ClusterAttach[] };
    return {
      hits: res.results ?? [],
      // degraded 是 Set 序列化（true=发生降级）或字符串集合；只关心非空
      degraded: Array.isArray(res.degraded) ? res.degraded.length > 0 : res.degraded === true,
      clusters: res.clusters ?? [],
    };
  }

  /**
   * load_context（会话恢复路径）：无 query，服务端按 activation×freshness
   * 排序返回 context 记忆（SearchResponse 同形，doc 同受注入面截断；纯读不强化）。
   * --prefill 臂取全库量后客户端过滤回该题会话集（与 --scope-user 同一手法）。
   */
  /** 双区响应：results（检索面）+ ambient（恒注入区——is@非 session 层，服务端
   *  ambient-topk 截断，0=关）。v2 开关态断言读 ambient 长度（amb-off 臂须为零）。 */
  async loadContext(contextId: string, topk: number): Promise<{ hits: SearchHit[]; ambient: SearchHit[] }> {
    const res = (await this.request(
      'GET',
      `/memories/load-context?context_id=${encodeURIComponent(contextId)}&topk=${topk}`,
    )) as { results?: SearchHit[]; ambient?: SearchHit[] };
    return { hits: res.results ?? [], ambient: res.ambient ?? [] };
  }

  /**
   * 按 mem_id 取条目全文。search 返回的 doc 被服务端按注入面配置截断（doc-max-chars，
   * 默认 512）——bench 答题要喂完整块文本，逐条经统一取回口拉全（facet=doc 纯读面；
   * 旧 /memories/doc-get 端点已收编进 GET /memories/get，retired 404——冒烟实锤过）。
   */
  async itemDoc(memId: string): Promise<string> {
    const res = (await this.request('GET', `/memories/get?mem_id=${encodeURIComponent(memId)}&facet=doc`)) as { doc?: unknown };
    return typeof res.doc === 'string' ? res.doc : '';
  }

  /** 写事实（POST /memories/doc-save，kind=is 钉死在端点）；带名 upsert、匿名插入新行。 */
  async docSave(contextId: string, doc: string, opts?: { name?: string; meta?: Record<string, unknown> }): Promise<string> {
    const res = (await this.request('POST', '/memories/doc-save', {
      context_id: contextId,
      doc,
      ...(opts?.name !== undefined ? { name: opts.name } : {}),
      ...(opts?.meta !== undefined ? { meta: opts.meta } : {}),
    })) as { mem_id?: unknown };
    if (typeof res.mem_id !== 'string') throw new Error(`doc-save 响应无 mem_id：${contextId}`);
    return res.mem_id;
  }

  /** 按名取条目全文（统一取回口 doc 面；404 → null，调用方给人话）。 */
  async docByName(contextId: string, name: string): Promise<{ doc: string; meta: Record<string, unknown> | null } | null> {
    try {
      const res = (await this.request(
        'GET',
        `/memories/get?context_id=${encodeURIComponent(contextId)}&name=${encodeURIComponent(name)}&facet=doc`,
      )) as { doc?: unknown; meta?: Record<string, unknown> | null };
      return { doc: typeof res.doc === 'string' ? res.doc : '', meta: res.meta ?? null };
    } catch (e) {
      if (e instanceof MemError && e.status === 404) return null;
      throw e;
    }
  }

  /**
   * 原文层逐批追加（POST /verbatim/bulk，全批一个事务——拒绝即整批 400，按段重试安全）。
   *  超过 200 行自动分段（服务端上限 500/批，留余量）；返回 vb_id 列表与入参行序对齐。
   */
  async verbatimBulk(contextId: string, rows: VerbatimWriteRow[]): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < rows.length; i += 200) {
      const chunk = rows.slice(i, i + 200);
      const res = (await this.request('POST', '/verbatim/bulk', {
        context_id: contextId,
        rows: chunk,
      })) as { vb_ids?: string[] };
      ids.push(...(res.vb_ids ?? []));
    }
    return ids;
  }

  /**
   * 原文层检索（GET /verbatim/search，0.9.79+）。scope 显式传 = bench 选面口径
   *  （self/descendants 对配置漂移免疫——配对消融的读窗不随服务端 scope 配置走）；
   *  minScore=0 拿门槛前候选（与条目面 search 同理）。附带块与命中同响应，纯呈现层。
   */
  async verbatimSearch(
    query: string,
    contextId: string,
    topk: number,
    opts?: { minScore?: number; scope?: 'self' | 'descendants' | 'auto'; clusters?: number },
  ): Promise<{ hits: VerbatimHit[]; degraded: boolean; clusters: ClusterAttach[] }> {
    const res = (await this.request(
      'GET',
      `/verbatim/search?q=${encodeURIComponent(query)}&context_id=${encodeURIComponent(contextId)}&topk=${topk}`
      + (opts?.minScore !== undefined ? `&min_score=${opts.minScore}` : '')
      + (opts?.scope !== undefined ? `&scope=${opts.scope}` : '')
      + (opts?.clusters !== undefined ? `&clusters=${opts.clusters}` : ''),
    )) as { results?: VerbatimHit[]; degraded?: unknown; clusters?: ClusterAttach[] };
    return {
      hits: res.results ?? [],
      degraded: Array.isArray(res.degraded) ? res.degraded.length > 0 : res.degraded === true,
      clusters: res.clusters ?? [],
    };
  }

  /**
   * bench 选面前置自检：坏 scope（up）应 400——参数校验活着。返 200 = 服务端
   *  scope-lock 把参数面整参关了，显式选面会静默走配置窗（配对消融变错且不可见），
   *  直接抛错拦下（解锁 = 摘掉 lmg.mem.verbatim.scope-lock 重启实例）。
   */
  async assertVerbatimScopeFace(): Promise<void> {
    let ok = false;
    try {
      await this.request('GET', `/verbatim/search?q=probe&context_id=${encodeURIComponent('/root')}&scope=up`);
    } catch (e) {
      if (e instanceof MemError && e.status === 400) ok = true;
      else throw e;
    }
    if (!ok) {
      throw new Error('scope 参数面失效（scope=up 返 200）——服务端开了 verbatim scope-lock，bench 显式选面臂不可跑；解锁后重试');
    }
  }

  /**
   * 原文层按 context 取行（GET /verbatim/recent，时间序最新 N 行——不计分、不走
   * 召回，formation 断言「行落库且可见」的核对面）。永不传 scope：v2 库服务端
   * scope-lock=true（读窗单源 auto），传参会被静默忽略——本方法只数行不选窗。
   */
  async verbatimRecent(contextId: string, limit: number): Promise<VerbatimHit[]> {
    const res = (await this.request(
      'GET',
      `/verbatim/recent?context_id=${encodeURIComponent(contextId)}&limit=${limit}`,
    )) as { results?: VerbatimHit[] };
    return res.results ?? [];
  }

  /**
   * 遗留未评估 session 清单（GET /lifecycle/unevaluated-sessions，服务端上限
   * limit≤100——超量自动钳 100：排空判据只关心「有没有」，>100 与 =100 同判非空）。
   */
  async unevaluatedSessions(limit: number): Promise<Array<{ contextId: string }>> {
    const n = Math.max(1, Math.min(limit, 100));
    const res = (await this.request('GET', `/lifecycle/unevaluated-sessions?limit=${n}`)) as unknown;
    return Array.isArray(res) ? (res as Array<{ context_id?: string; contextId?: string }>).map(r => ({
      contextId: r.context_id ?? r.contextId ?? '',
    })) : [];
  }

  async health(): Promise<HealthReport> {
    const res = (await this.request('GET', '/actuator/health')) as {
      status: string;
      components?: Record<string, { status: string; details?: Record<string, unknown> }>;
    };
    const outbox = res.components?.['outbox'];
    const embed = res.components?.['embed'];
    return {
      status: res.status,
      outboxPending: Number(outbox?.details?.['pending'] ?? 0),
      outboxDead: Number(outbox?.details?.['dead'] ?? 0),
      verbatimPending: Number(outbox?.details?.['verbatim_pending'] ?? 0),
      verbatimDead: Number(outbox?.details?.['verbatim_dead'] ?? 0),
      embedProvider: (embed?.details?.['provider'] as string) ?? null,
      embedStatus: embed?.status ?? null,
    };
  }

  /**
   * ingest 后等 outbox 排空（向量化异步）。死信即抛——0.9.83 起条目面死信重排收
   * service 面（bench 侧无重排口，与 verbatim 同口径）；永久性错误需要人工看。
   * 每 pollMs 查一次，verbose 周期打印积压。
   */
  async waitForOutboxDrain(timeoutMs: number, log: (msg: string) => void, pollMs = 3000): Promise<void> {
    const start = Date.now();
    let lastLog = 0;
    let netFails = 0; // 瞬时网络故障容忍（fetch 层异常≠服务死）：连续 3 次才放弃，deadline 仍兜底
    for (;;) {
      let h: HealthReport;
      try {
        h = await this.health();
        netFails = 0;
      } catch (e) {
        if (++netFails >= 3 || Date.now() - start > timeoutMs) throw e;
        log(`health 瞬时失败（${netFails}/3）：${(e as Error)?.cause ?? String(e)}`);
        await sleep(pollMs);
        continue;
      }
      const elapsed = Date.now() - start;
      if (h.outboxDead > 0) {
        throw new Error(`outbox 死信 ${h.outboxDead} 条——重排口已收 service 面（0.9.83），需人工介入（health: ${h.status}）`);
      }
      if (h.outboxPending === 0) {
        log(`outbox 排空（${Math.round(elapsed / 1000)}s）`);
        return;
      }
      if (elapsed - lastLog > (elapsed < 120_000 ? 30_000 : 300_000)) {
        // 前 2min 每 30s 一条；之后退避到 5min 一条（全量灌库动辄数小时，高频刷屏是纯噪声）
        lastLog = elapsed;
        log(`outbox 积压 ${h.outboxPending}，等待向量化…（${Math.round(elapsed / 1000)}s）`);
      }
      if (elapsed > timeoutMs) {
        throw new Error(`outbox 排空超时（${Math.round(timeoutMs / 60000)}min，剩 ${h.outboxPending}）`);
      }
      await sleep(pollMs);
    }
  }

  /**
   * verbatim 灌录后等向量化排空（verbatim_pending → 0）。与 outbox 不同点：死信无
   *  HTTP 重排口（原文行只增不改、无 upsert 恢复路）——死信 > 0 直接抛错人工介入。
   */
  async waitForVerbatimDrain(timeoutMs: number, log: (msg: string) => void, pollMs = 3000): Promise<void> {
    const start = Date.now();
    let lastLog = 0;
    let netFails = 0;
    for (;;) {
      let h: HealthReport;
      try {
        h = await this.health();
        netFails = 0;
      } catch (e) {
        if (++netFails >= 3 || Date.now() - start > timeoutMs) throw e;
        log(`health 瞬时失败（${netFails}/3）：${(e as Error)?.cause ?? String(e)}`);
        await sleep(pollMs);
        continue;
      }
      const elapsed = Date.now() - start;
      if (h.verbatimDead > 0) {
        throw new Error(`verbatim 死信 ${h.verbatimDead} 条（无重排口，人工看 bench 实例日志）`);
      }
      if (h.verbatimPending === 0) {
        log(`verbatim 向量化排空（${Math.round(elapsed / 1000)}s）`);
        return;
      }
      if (elapsed - lastLog > (elapsed < 120_000 ? 30_000 : 300_000)) {
        lastLog = elapsed;
        log(`verbatim 积压 ${h.verbatimPending}，等待向量化…（${Math.round(elapsed / 1000)}s）`);
      }
      if (elapsed > timeoutMs) {
        throw new Error(`verbatim 排空超时（${Math.round(timeoutMs / 60000)}min，剩 ${h.verbatimPending}）`);
      }
      await sleep(pollMs);
    }
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 多查询列表组装：原问句恒为 q[0]（best-max 融合下保底不丢原分），变体仅收
 * 非空字符串、去精确重复，总条数封顶 maxTotal（bench 侧安全边，服务端上限 8）。
 */
export function assembleMqQueries(original: string, variants: unknown, maxTotal = 4): string[] {
  const out = [original.trim()];
  const seen = new Set(out);
  if (Array.isArray(variants)) {
    for (const v of variants) {
      if (typeof v !== 'string') continue;
      const s = v.trim();
      if (s.length === 0 || seen.has(s) || out.length >= maxTotal) continue;
      out.push(s);
      seen.add(s);
    }
  }
  return out;
}
