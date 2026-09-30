import OpenAI from 'openai';
import type { ChatRequest, ChatResponse, ModelProvider, NeutralMessage, ToolCall, Usage } from './types.ts';
import { ProviderError } from './types.ts';
import { redact } from '../secrets.ts';

type MessageParam = OpenAI.Chat.ChatCompletionMessageParam;

/**
 * Chat Completions adapter. Covers OpenAI itself plus the many services that speak
 * the same protocol: OpenRouter, Gemini's OpenAI endpoint, Groq, Mistral, DeepSeek,
 * xAI, Together, Vercel AI Gateway, and local servers like Ollama or LM Studio.
 */
export class OpenAIProvider implements ModelProvider {
  private client: OpenAI;
  private streamUsageOk = true;

  constructor(
    readonly id: string,
    readonly label: string,
    readonly kind: 'openai' | 'openai_compat',
    apiKey: string | null,
    baseUrl: string | null,
  ) {
    // The SDK refuses to start without a key; local servers ignore whatever it sends.
    this.client = new OpenAI({ apiKey: apiKey || 'not-needed', baseURL: baseUrl ?? undefined, maxRetries: 2 });
  }

  async listModels(): Promise<string[]> {
    try {
      const ids: string[] = [];
      for await (const m of this.client.models.list()) ids.push(m.id);
      return ids.sort();
    } catch (err) {
      throw toProviderError(err);
    }
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    try {
      return await this.stream(req);
    } catch (err) {
      // Some compatible servers reject stream_options; retry once without usage reporting.
      if (this.streamUsageOk && err instanceof OpenAI.BadRequestError && /stream_options|include_usage/i.test(err.message)) {
        this.streamUsageOk = false;
        return this.stream(req).catch((e) => {
          throw toProviderError(e);
        });
      }
      throw toProviderError(err);
    }
  }

  private async stream(req: ChatRequest): Promise<ChatResponse> {
    const body: OpenAI.Chat.ChatCompletionCreateParamsStreaming = {
      model: req.model,
      messages: toOpenAIMessages(req.system, req.messages),
      stream: true,
    };
    if (req.tools.length) body.tools = req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
    if (this.streamUsageOk) body.stream_options = { include_usage: true };
    if (this.kind === 'openai') {
      body.max_completion_tokens = req.maxTokens;
      if (/^(o\d|gpt-5)/.test(req.model)) body.reasoning_effort = req.effort;
    } else {
      body.max_tokens = req.maxTokens;
    }

    const stream = await this.client.chat.completions.create(body, { signal: req.signal });
    let text = '';
    let finish: string | null = null;
    let model = req.model;
    const usage: Usage = { input: 0, output: 0 };
    const calls = new Map<number, { id: string; name: string; args: string }>();

    for await (const chunk of stream) {
      model = chunk.model || model;
      if (chunk.usage) {
        const cached = chunk.usage.prompt_tokens_details?.cached_tokens ?? 0;
        usage.input = chunk.usage.prompt_tokens - cached;
        usage.output = chunk.usage.completion_tokens;
        if (cached) usage.cacheRead = cached;
      }
      const choice = chunk.choices[0];
      if (!choice) continue;
      const d = choice.delta;
      if (d.content) {
        text += d.content;
        req.onText?.(d.content);
      }
      // DeepSeek and OpenRouter stream reasoning in fields the OpenAI types don't declare.
      const reasoning = 'reasoning_content' in d ? d.reasoning_content : 'reasoning' in d ? d.reasoning : null;
      if (typeof reasoning === 'string' && reasoning) req.onThinking?.(reasoning);
      for (const tc of d.tool_calls ?? []) {
        const cur = calls.get(tc.index) ?? { id: '', name: '', args: '' };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name += tc.function.name;
        if (tc.function?.arguments) cur.args += tc.function.arguments;
        calls.set(tc.index, cur);
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }

    const toolCalls: ToolCall[] = [...calls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([i, c]) => {
        const id = c.id || `call_${Date.now().toString(36)}_${i}`;
        if (!c.args.trim()) return { id, name: c.name, args: {} };
        try {
          return { id, name: c.name, args: JSON.parse(c.args) };
        } catch {
          return { id, name: c.name, args: {}, invalidArgs: c.args.slice(0, 2000) };
        }
      });

    // Truncation wins: a cut-off tool call must never run.
    let stopReason: ChatResponse['stopReason'] = 'other';
    if (finish === 'length') stopReason = 'max_tokens';
    else if (finish === 'content_filter') stopReason = 'refusal';
    else if (finish === 'tool_calls' || toolCalls.length) stopReason = 'tool_use';
    else if (finish === 'stop') stopReason = 'end';
    return { text, toolCalls, usage, model, stopReason };
  }
}

function toOpenAIMessages(system: string, messages: NeutralMessage[]): MessageParam[] {
  const out: MessageParam[] = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (m.role === 'assistant') {
      out.push({
        role: 'assistant',
        content: m.text || (m.toolCalls.length ? null : '(no output)'),
        ...(m.toolCalls.length
          ? { tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: 'function' as const, function: { name: c.name, arguments: c.invalidArgs ?? JSON.stringify(c.args) } })) }
          : {}),
      });
      continue;
    }
    for (const r of m.toolResults ?? []) out.push({ role: 'tool', tool_call_id: r.id, content: r.content || '(empty)' });
    if (m.content.trim() || !m.toolResults?.length) out.push({ role: 'user', content: m.content || '(continue)' });
  }
  return out;
}

function toProviderError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  if (err instanceof OpenAI.APIUserAbortError) return new ProviderError('Request cancelled', false);
  if (err instanceof OpenAI.AuthenticationError) return new ProviderError('The provider rejected the API key (401). Check the key in Settings.', false, 401);
  if (err instanceof OpenAI.NotFoundError) return new ProviderError(`Model or endpoint not found (404): ${redact(err.message)}`, false, 404);
  if (err instanceof OpenAI.RateLimitError) return new ProviderError(`Rate limited (429) after retries: ${redact(err.message)}`, true, 429);
  if (err instanceof OpenAI.BadRequestError) return new ProviderError(`The provider rejected the request (400): ${redact(err.message)}`, false, 400);
  if (err instanceof OpenAI.InternalServerError) return new ProviderError(`Provider server error: ${redact(err.message)}`, true, 500);
  if (err instanceof OpenAI.APIConnectionError) return new ProviderError(`Could not reach the provider: ${redact(err.message)}`, true);
  if (err instanceof OpenAI.APIError) return new ProviderError(`Provider error: ${redact(err.message)}`, false, err.status);
  return new ProviderError(redact(err instanceof Error ? err.message : String(err)), false);
}
