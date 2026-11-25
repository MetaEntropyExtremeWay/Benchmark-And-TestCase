/**
 * LLM 客户端（OpenAI 兼容 /chat/completions）。
 * 跑分口径：模型钉死 + thinking 关闭（部分模型的 thinking 会吃掉
 * max_tokens 预算，挤占 JSON 输出空间）+ 低温度。
 * 网络类失败（超时 / 5xx / 429）重试最多 retries 次，指数退避。
 */
import type { TokenUsage } from './types.ts';
import { sleep } from './mem.ts';

export interface ChatOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  system: string;
  user: string;
  timeoutMs: number;
  maxTokens: number;
  retries?: number;
  /** 工具面（API 探针用）：给出则带 tools + tool_choice=auto */
  tools?: ToolDef[];
  /** 完整对话（工具循环用）：给出则覆盖 system/user 单轮形态 */
  messages?: ChatMessage[];
}

export interface ToolDef {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

/** glm 合规：带 tool_calls 的 assistant 消息 content 必须是 null（不能空串）——回传时照此构造。 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  /** assistant 原样回传（function.name/arguments 字符串形态） */
  tool_calls?: Array<{ id?: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

export interface ToolCall {
  id?: string;
  name: string;
  arguments: string; // JSON 字符串（模型原样）
}

export interface ChatResult {
  content: string;
  toolCalls?: ToolCall[];
  usage: TokenUsage;
  elapsedMs: number;
}

export class LlmError extends Error {}

export async function chat(o: ChatOptions): Promise<ChatResult> {
  const retries = o.retries ?? 2;
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(2000 * attempt);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), o.timeoutMs);
    const start = Date.now();
    try {
      const res = await fetch(o.baseUrl + '/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${o.apiKey}` },
        signal: controller.signal,
        body: JSON.stringify({
          model: o.model,
          messages: o.messages ?? [
            { role: 'system', content: o.system },
            { role: 'user', content: o.user },
          ],
          temperature: 0.01,
          max_tokens: o.maxTokens,
          thinking: { type: 'disabled' },
          stream: false,
          ...(o.tools ? { tools: o.tools, tool_choice: 'auto' } : {}),
        }),
      });
      const text = await res.text();
      if (!res.ok) {
        // 4xx（除 429）是请求问题，重试无益
        if (res.status >= 400 && res.status < 500 && res.status !== 429) {
          throw new LlmError(`LLM ${res.status}: ${text.slice(0, 300)}`);
        }
        throw new Error(`LLM ${res.status}: ${text.slice(0, 300)}`);
      }
      const data = JSON.parse(text) as {
        choices?: Array<{ message?: { content?: string | null; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const msg = data.choices?.[0]?.message;
      const toolCalls: ToolCall[] = (msg?.tool_calls ?? [])
        .filter(tc => tc?.function?.name)
        .map(tc => ({ id: tc.id, name: tc.function!.name as string, arguments: tc.function!.arguments ?? '{}' }));
      const content = msg?.content;
      // 工具回合 content 可为 null（只发 tool_calls）；两者皆空才是坏响应
      if ((content == null || content === '') && toolCalls.length === 0) {
        throw new Error(`LLM 空 content（usage=${JSON.stringify(data.usage)}）`);
      }
      return {
        content: content ?? '',
        toolCalls,
        usage: {
          prompt: data.usage?.prompt_tokens ?? 0,
          completion: data.usage?.completion_tokens ?? 0,
        },
        elapsedMs: Date.now() - start,
      };
    } catch (e) {
      lastErr = e;
      if (e instanceof LlmError) throw e;
      // 429（限速）的窗口常是几十秒级：短退避只会连撞，改长退避（15s×次数）
      if (e instanceof Error && e.message.includes('LLM 429')) await sleep(15_000 * (attempt + 1));
      // 超时 / 网络 / 5xx → 退避重试
    } finally {
      clearTimeout(timer);
    }
  }
  throw new LlmError(`LLM 调用重试 ${retries} 次后仍失败: ${String(lastErr)}`);
}

/** 从 judge 输出抠 JSON（容忍代码围栏 / 前后闲话）。 */
export function parseJsonLoose(text: string): unknown {
  const fenced = text.replace(/```(?:json)?/g, '');
  const start = fenced.indexOf('{');
  if (start < 0) throw new Error('judge 输出无 JSON 对象');
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < fenced.length; i++) {
    const c = fenced[i];
    if (esc) {
      esc = false;
      continue;
    }
    if (c === '\\') {
      esc = true;
      continue;
    }
    if (c === '"') inStr = !inStr;
    if (inStr) continue;
    if (c === '{') depth++;
    if (c === '}') {
      depth--;
      if (depth === 0) return JSON.parse(fenced.slice(start, i + 1));
    }
  }
  throw new Error('judge 输出 JSON 不完整');
}
