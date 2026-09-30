import type { Agent, Effort, Run, Task } from '../../shared/types.ts';

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  /** Whatever JSON the model sent; the tool's schema validates it before anything runs. */
  args: unknown;
  /** Set when the model produced arguments that were not valid JSON. */
  invalidArgs?: string;
}

export interface ToolResult {
  id: string;
  name: string;
  content: string;
  isError?: boolean;
}

/**
 * Provider-neutral transcript. Assistant turns keep the provider's raw content so
 * the same provider/model can be replayed byte-for-byte (Anthropic requires
 * thinking blocks to be echoed back unchanged).
 */
export type NeutralMessage =
  | { role: 'user'; content: string; toolResults?: ToolResult[] }
  | {
      role: 'assistant';
      text: string;
      toolCalls: ToolCall[];
      raw?: { providerId: string; model: string; content: unknown };
      demo?: boolean;
    };

export type Phase = 'plan' | 'task' | 'synth' | 'replan' | 'consult' | 'chat';

/** What the orchestrator knows about the current step, beyond who is taking it. */
export interface DemoContext {
  run?: Run;
  task?: Task;
  goal?: string;
  depArtifacts?: { id: string; name: string; agentId: string | null }[];
  question?: string;
}

/** Context the demo provider uses to pick a plausible next move. Real providers ignore it. */
export interface DemoHint extends DemoContext {
  phase: Phase;
  agent: Agent;
  teammates: Agent[];
}

export interface ChatRequest {
  model: string;
  system: string;
  messages: NeutralMessage[];
  tools: ToolSpec[];
  effort: Effort;
  maxTokens: number;
  signal: AbortSignal;
  onText?: (delta: string) => void;
  onThinking?: (delta: string) => void;
  hint: DemoHint;
}

export interface Usage {
  /** Uncached input tokens. */
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface ChatResponse {
  text: string;
  toolCalls: ToolCall[];
  usage: Usage;
  stopReason: 'end' | 'tool_use' | 'max_tokens' | 'refusal' | 'other';
  refusalDetail?: string;
  model: string;
  raw?: unknown;
  demo?: boolean;
}

export interface ModelProvider {
  id: string;
  kind: 'anthropic' | 'openai' | 'openai_compat' | 'demo';
  label: string;
  chat(req: ChatRequest): Promise<ChatResponse>;
  listModels(): Promise<string[]>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
  }
}
