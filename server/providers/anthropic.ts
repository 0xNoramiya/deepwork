import Anthropic from '@anthropic-ai/sdk';
import type { ChatRequest, ChatResponse, ModelProvider, NeutralMessage, ToolCall, Usage } from './types.ts';
import { ProviderError } from './types.ts';
import { redact } from '../secrets.ts';

type Params = Parameters<Anthropic['beta']['messages']['stream']>[0];
type MessageParam = Anthropic.Beta.Messages.BetaMessageParam;
type ContentBlockParam = Anthropic.Beta.Messages.BetaContentBlockParam;
type Message = Anthropic.Beta.Messages.BetaMessage;

// Model capability checks by id. Newer models reject sampling params and fixed
// thinking budgets, so we only send what each generation accepts.
const ADAPTIVE = /claude-(opus-4-[6-9]|opus-5|sonnet-4-6|sonnet-5|fable|mythos)/;
const EFFORT = /claude-(opus-4-[5-9]|opus-5|sonnet-4-6|sonnet-5|fable|mythos)/;
const DISPLAY = /claude-(opus-4-[7-9]|opus-5|sonnet-5|fable|mythos)/;
const SERVER_FALLBACK = /claude-(opus-5|sonnet-5-5|fable-5-1)/;

export class AnthropicProvider implements ModelProvider {
  kind = 'anthropic' as const;
  private client: Anthropic;
  private fallbacksOk: boolean;
  private firstParty: boolean;

  constructor(
    readonly id: string,
    readonly label: string,
    apiKey: string,
    baseUrl: string | null,
  ) {
    this.client = new Anthropic({ apiKey, baseURL: baseUrl ?? undefined, maxRetries: 2 });
    // Server-side refusal fallback and automatic caching exist on the first-party API only.
    this.firstParty = !baseUrl;
    this.fallbacksOk = this.firstParty;
  }

  async listModels(): Promise<string[]> {
    try {
      const ids: string[] = [];
      for await (const m of this.client.models.list()) ids.push(m.id);
      return ids;
    } catch (err) {
      throw toProviderError(err);
    }
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const useFallback = this.fallbacksOk && SERVER_FALLBACK.test(req.model);
    try {
      return await this.stream(req, useFallback);
    } catch (err) {
      // If the account or model rejects the fallback beta, retry once without it.
      if (useFallback && err instanceof Anthropic.BadRequestError && /fallback/i.test(err.message)) {
        this.fallbacksOk = false;
        return this.stream(req, false).catch((e) => {
          throw toProviderError(e);
        });
      }
      throw toProviderError(err);
    }
  }

  private async stream(req: ChatRequest, useFallback: boolean): Promise<ChatResponse> {
    const params: Params = {
      model: req.model,
      max_tokens: req.maxTokens,
      // The system prompt is stable for a whole task loop: a fixed cache breakpoint there,
      // plus automatic caching of the growing transcript on the first-party API.
      system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
      messages: toAnthropicMessages(req.messages, this.id, req.model),
      tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: { ...t.parameters, type: 'object' }, eager_input_streaming: true })),
    };
    if (ADAPTIVE.test(req.model)) params.thinking = DISPLAY.test(req.model) ? { type: 'adaptive', display: 'summarized' } : { type: 'adaptive' };
    if (EFFORT.test(req.model)) params.output_config = { effort: req.effort };
    if (this.firstParty) params.cache_control = { type: 'ephemeral' };
    if (useFallback) {
      params.betas = ['server-side-fallback-2026-07-01'];
      params.fallbacks = 'default';
    }

    // A tool input that fails to parse rejects finalMessage() with a non-API error;
    // re-issue the turn a couple of times before giving up.
    for (let attempt = 0; ; attempt++) {
      const stream = this.client.beta.messages.stream(params, { signal: req.signal });
      for await (const ev of stream) {
        if (ev.type !== 'content_block_delta') continue;
        if (ev.delta.type === 'text_delta') req.onText?.(ev.delta.text);
        if (ev.delta.type === 'thinking_delta') req.onThinking?.(ev.delta.thinking);
      }
      try {
        return fromAnthropicMessage(await stream.finalMessage());
      } catch (err) {
        if (err instanceof Anthropic.APIError || req.signal.aborted || attempt >= 2) throw err;
      }
    }
  }
}

function fromAnthropicMessage(msg: Message): ChatResponse {
  // After a mid-output fallback, blocks before the last `fallback` marker belong to
  // the declined attempt: keep their text, drop their thinking and tool calls.
  const lastFallback = msg.content.map((b) => b.type).lastIndexOf('fallback');
  const content = msg.content.filter((b, i) => i > lastFallback || b.type === 'text');
  const text = content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
  const toolCalls: ToolCall[] = content.flatMap((b) => (b.type === 'tool_use' ? [{ id: b.id, name: b.name, args: b.input }] : []));
  const stop = msg.stop_reason;
  return {
    text,
    toolCalls,
    usage: usageOf(msg.usage),
    model: msg.model,
    raw: content,
    stopReason:
      stop === 'tool_use' ? 'tool_use' : stop === 'end_turn' ? 'end' : stop === 'max_tokens' ? 'max_tokens' : stop === 'refusal' ? 'refusal' : 'other',
    refusalDetail: stop === 'refusal' ? [msg.stop_details?.category, msg.stop_details?.explanation].filter(Boolean).join(': ') || undefined : undefined,
  };
}

/** With fallbacks, usage.iterations is the per-attempt source of truth. */
function usageOf(u: Message['usage']): Usage {
  const attempts = u.iterations?.length ? u.iterations : [u];
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  for (const a of attempts) {
    input += a.input_tokens;
    output += a.output_tokens;
    cacheRead += a.cache_read_input_tokens ?? 0;
    cacheWrite += a.cache_creation_input_tokens ?? 0;
  }
  return { input, output, ...(cacheRead ? { cacheRead } : {}), ...(cacheWrite ? { cacheWrite } : {}) };
}

function toAnthropicMessages(messages: NeutralMessage[], providerId: string, model: string): MessageParam[] {
  return messages.map((m): MessageParam => {
    if (m.role === 'assistant') {
      if (m.raw && m.raw.providerId === providerId && m.raw.model === model) {
        // This provider's own response content for this model, which the API takes back verbatim
        // (thinking blocks must be echoed unchanged).
        return { role: 'assistant', content: m.raw.content as ContentBlockParam[] };
      }
      const content: ContentBlockParam[] = [];
      if (m.text.trim()) content.push({ type: 'text', text: m.text });
      for (const c of m.toolCalls) content.push({ type: 'tool_use', id: c.id, name: c.name, input: c.args });
      return { role: 'assistant', content: content.length ? content : [{ type: 'text', text: '(no output)' }] };
    }
    const content: ContentBlockParam[] = (m.toolResults ?? []).map((r) => ({ type: 'tool_result', tool_use_id: r.id, content: r.content || '(empty)', is_error: r.isError || undefined }));
    if (m.content.trim()) content.push({ type: 'text', text: m.content });
    return { role: 'user', content: content.length ? content : [{ type: 'text', text: '(continue)' }] };
  });
}

function toProviderError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  if (err instanceof Anthropic.APIUserAbortError) return new ProviderError('Request cancelled', false);
  if (err instanceof Anthropic.AuthenticationError) return new ProviderError('Anthropic rejected the API key (401). Check the key in Settings.', false, 401);
  if (err instanceof Anthropic.PermissionDeniedError) return new ProviderError(`Anthropic denied access (403): ${redact(err.message)}`, false, 403);
  if (err instanceof Anthropic.NotFoundError) return new ProviderError(`Model or endpoint not found (404): ${redact(err.message)}`, false, 404);
  if (err instanceof Anthropic.RateLimitError) return new ProviderError('Rate limited by Anthropic (429) after retries.', true, 429);
  if (err instanceof Anthropic.BadRequestError) return new ProviderError(`Anthropic rejected the request (400): ${redact(err.message)}`, false, 400);
  if (err instanceof Anthropic.InternalServerError) return new ProviderError(`Anthropic server error: ${redact(err.message)}`, true, 500);
  if (err instanceof Anthropic.APIConnectionError) return new ProviderError(`Could not reach Anthropic: ${redact(err.message)}`, true);
  if (err instanceof Anthropic.APIError) return new ProviderError(`Anthropic error: ${redact(err.message)}`, false, err.status);
  return new ProviderError(redact(err instanceof Error ? err.message : String(err)), false);
}
