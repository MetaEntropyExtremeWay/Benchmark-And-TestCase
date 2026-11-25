import { describe, expect, it } from 'vitest';
import { MemClient, assembleMqQueries } from '../shared/mem.ts';

/** 假 fetch：记录请求 URL，返回空结果（search 只关心 URL 构造）。 */
function captureFetch(): { fetchImpl: typeof fetch; url: () => string } {
  let lastUrl = '';
  const fetchImpl = (async (url: unknown) => {
    lastUrl = String(url);
    return new Response(JSON.stringify({ results: [], degraded: [] }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, url: () => lastUrl };
}

const BASE = 'http://mem.test';

describe('search 多查询 URL 构造', () => {
  it('字符串单查询 → 单个 q=', async () => {
    const cap = captureFetch();
    const mem = new MemClient({ baseUrl: BASE, fetchImpl: cap.fetchImpl });
    await mem.search('what camera', '/root/bench/r1', 10);
    expect(cap.url()).toBe(`${BASE}/memories/search?q=what%20camera&context_id=%2Froot%2Fbench%2Fr1&topk=10`);
  });

  it('数组多查询 → 重复 q= 保持顺序（服务端 ?q=a&q=b 契约）', async () => {
    const cap = captureFetch();
    const mem = new MemClient({ baseUrl: BASE, fetchImpl: cap.fetchImpl });
    await mem.search(['原问句', 'camera model', 'trip to Japan'], '/root/bench/r1', 20);
    const qParams = cap.url().split('?')[1].split('&').filter(p => p.startsWith('q='));
    expect(qParams).toEqual([
      'q=' + encodeURIComponent('原问句'),
      'q=' + encodeURIComponent('camera model'),
      'q=' + encodeURIComponent('trip to Japan'),
    ]);
    expect(cap.url()).toContain('&topk=20');
  });

  it('空串/纯空白过滤；超 8 条截断（服务端 MAX_QUERIES=8 超限 400）', async () => {
    const cap = captureFetch();
    const mem = new MemClient({ baseUrl: BASE, fetchImpl: cap.fetchImpl });
    const ten = ['q1', '', '  ', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7', 'q8', 'q9', 'q10'];
    await mem.search(ten, '/root/bench/r1', 10);
    const qParams = cap.url().split('?')[1].split('&').filter(p => p.startsWith('q='));
    expect(qParams).toHaveLength(8);
    expect(qParams[0]).toBe('q=q1');
    expect(qParams[7]).toBe('q=q8'); // q9/q10 被截掉
  });

  it('reinforce=false 追加参数（诊断读不强化）', async () => {
    const cap = captureFetch();
    const mem = new MemClient({ baseUrl: BASE, fetchImpl: cap.fetchImpl });
    await mem.search('q', '/c', 10, { reinforce: false });
    expect(cap.url()).toContain('&reinforce=false');
  });
});

describe('统一取回口（doc 全文拉取）', () => {
  // 客户端曾带 retired 的 /memories/doc-get（收编进 /get 后服务端断言 404）——此处钉住路径防再漂。
  it('itemDoc → /memories/get?mem_id=…&facet=doc（纯读面）', async () => {
    const cap = captureFetch();
    const mem = new MemClient({ baseUrl: BASE, fetchImpl: cap.fetchImpl });
    await mem.itemDoc('m-123');
    expect(cap.url()).toBe(`${BASE}/memories/get?mem_id=m-123&facet=doc`);
  });

  it('docByName → context_id+name 定位同端点 facet=doc', async () => {
    const cap = captureFetch();
    const mem = new MemClient({ baseUrl: BASE, fetchImpl: cap.fetchImpl });
    await mem.docByName('/root/bench/r1', 'camera model');
    expect(cap.url()).toBe(
      `${BASE}/memories/get?context_id=${encodeURIComponent('/root/bench/r1')}&name=${encodeURIComponent('camera model')}&facet=doc`);
  });
});

describe('search clusters 同团附带（mem 0.9.77+）与 docSave', () => {
  /** 假 fetch 记全请求面（method/path/body）与可配响应。 */
  function recordFetch(respBody: unknown): { fetchImpl: typeof fetch; calls: () => Array<{ method: string; path: string; body?: unknown }> } {
    const made: Array<{ method: string; path: string; body?: unknown }> = [];
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      made.push({
        method: String(init?.method ?? 'GET'),
        path: String(url).slice(BASE.length),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return new Response(JSON.stringify(respBody), { status: 200 });
    }) as unknown as typeof fetch;
    return { fetchImpl, calls: () => made };
  }

  it('clusters 参数追加 &clusters=；响应附带块透传、缺省空表', async () => {
    const cap = recordFetch({
      results: [], degraded: [],
      clusters: [{ cluster: 's3-c2', docs: ['[d] user: Japan'] }],
    });
    const mem = new MemClient({ baseUrl: BASE, fetchImpl: cap.fetchImpl });
    const r = await mem.search('q', '/c', 20, { reinforce: false, minScore: 0, clusters: 3 });
    expect(cap.calls()[0].path).toContain('&clusters=3');
    expect(r.clusters).toEqual([{ cluster: 's3-c2', docs: ['[d] user: Japan'] }]);
    const cap2 = recordFetch({ results: [], degraded: [] });
    const mem2 = new MemClient({ baseUrl: BASE, fetchImpl: cap2.fetchImpl });
    const r2 = await mem2.search('q', '/c', 20); // 未开附带 → 空表
    expect(cap2.calls()[0].path).not.toContain('clusters=');
    expect(r2.clusters).toEqual([]);
  });

  it('docSave → POST /memories/doc-save（context_id/doc/name/meta 全量；mem_id 返回）', async () => {
    const cap = recordFetch({ mem_id: 'm-1', meta: { version: 1 } });
    const mem = new MemClient({ baseUrl: BASE, fetchImpl: cap.fetchImpl });
    const id = await mem.docSave('/root/p/s-main', '[d] user: hi', { name: 's0-m0', meta: { engram: 's0-c0' } });
    expect(id).toBe('m-1');
    const c = cap.calls()[0];
    expect(c.method).toBe('POST');
    expect(c.path).toBe(`${BASE}/memories/doc-save`.slice(BASE.length));
    expect(c.body).toEqual({ context_id: '/root/p/s-main', doc: '[d] user: hi', name: 's0-m0', meta: { engram: 's0-c0' } });
  });

  it('docSave 响应无 mem_id → 抛错（防静默丢写）', async () => {
    const cap = recordFetch({});
    const mem = new MemClient({ baseUrl: BASE, fetchImpl: cap.fetchImpl });
    await expect(mem.docSave('/c', 'd')).rejects.toThrow(/无 mem_id/);
  });
});

describe('assembleMqQueries 变体组装', () => {
  it('原问句恒为 [0]，变体随后，总量封顶 4', () => {
    expect(assembleMqQueries('original q', ['v1', 'v2', 'v3', 'v4'])).toEqual(['original q', 'v1', 'v2', 'v3']);
  });

  it('非字符串 / 空白 / 与原问句重复的变体被滤掉', () => {
    expect(assembleMqQueries('original q', [42, null, '   ', 'original q', 'v1'])).toEqual(['original q', 'v1']);
  });

  it('全垃圾输入 → 仅原问句（降级单查询）', () => {
    expect(assembleMqQueries('original q', 'not-an-array')).toEqual(['original q']);
    expect(assembleMqQueries('original q', [])).toEqual(['original q']);
  });

  it('变体做 trim（LLM 输出常带首尾空白）', () => {
    expect(assembleMqQueries('q', ['  v1  '])).toEqual(['q', 'v1']);
  });
});
