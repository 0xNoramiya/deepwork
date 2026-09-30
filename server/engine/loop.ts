import type { Agent, DecisionRequest } from '../../shared/types.ts';
import { agents, runs, tasks as taskDb, transcripts } from '../db.ts';
import { broadcast, log, streamDelta, streamReset } from '../bus.ts';
import { getProvider, providerMeta } from '../providers/index.ts';
import { costOf, priceFor } from '../providers/pricing.ts';
import type { ChatResponse, DemoContext, NeutralMessage, Phase, ToolCall, ToolResult } from '../providers/types.ts';
import { ProviderError } from '../providers/types.ts';
import { redact } from '../secrets.ts';
import { setLive } from './live.ts';
import { systemPrompt } from './prompts.ts';
import { TOOL_BY_NAME, toolsFor, specOf, type Final, type ToolCtx } from './tools.ts';

export class Cancelled extends Error {
  constructor(msg = 'Cancelled') {
    super(msg);
  }
}

/** A failure we should report to the Captain as-is (bad key, refusal, missing model). */
export class TaskFailure extends Error {}

class Stuck extends Error {}

export type LoopResult = { kind: 'final'; final: Final } | { kind: 'blocked'; reason: string };

export interface LoopEnv {
  runId: string;
  agentId: string;
  phase: Phase;
  owner: string;
  taskId?: string;
  brief(): string;
  maxSteps: number;
  signal: AbortSignal;
  limits: { consults: number; questions: number };
  gate(): Promise<void>;
  requestHuman(req: Omit<DecisionRequest, 'id' | 'status' | 'response' | 'createdAt' | 'resolvedAt'>, signal: AbortSignal): Promise<string>;
  consult(asker: Agent, target: Agent, question: string, signal: AbortSignal): Promise<string>;
  takeNotes(): string[];
  hint(): DemoContext;
}

const REPEAT_OK = new Set(['list_artifacts', 'ask_user']);

/** Key-order-independent serialisation, so repeated calls compare equal however the model orders arguments. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.entries(v)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, x]) => `${k}:${stable(x)}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

export function charge(runId: string, taskId: string | undefined, agent: Agent, resp: Pick<ChatResponse, 'usage' | 'demo'>): number {
  const meta = providerMeta(agent.providerId);
  const price = priceFor(agent, meta?.kind ?? 'demo', meta?.baseUrl ?? null);
  const cost = costOf(resp.usage, price);
  const run = runs.get(runId);
  if (run) {
    run.spentUsd += cost;
    run.tokensIn += resp.usage.input + (resp.usage.cacheRead ?? 0) + (resp.usage.cacheWrite ?? 0);
    run.tokensOut += resp.usage.output;
    if (resp.demo) run.demo = true;
    run.updatedAt = Date.now();
    runs.put(run);
    broadcast({ kind: 'upsert', entity: 'run', data: run });
  }
  if (taskId) {
    const t = taskDb.get(taskId);
    if (t) {
      t.spentUsd += cost;
      taskDb.put(t);
      broadcast({ kind: 'upsert', entity: 'task', data: t });
    }
  }
  return cost;
}

/**
 * Notes can be appended to a transcript while nothing is running (retries, the
 * lead's guidance), which may leave two user turns in a row. Merge them on load so
 * every provider sees strictly alternating turns. Stored rows stay append-only.
 */
function normalize(rows: NeutralMessage[]): NeutralMessage[] {
  const out: NeutralMessage[] = [];
  for (const m of rows) {
    const last = out[out.length - 1];
    if (last && last.role === 'user' && m.role === 'user') {
      out[out.length - 1] = {
        role: 'user',
        content: [last.content, m.content].filter((x) => x.trim()).join('\n\n'),
        toolResults: [...(last.toolResults ?? []), ...(m.toolResults ?? [])],
      };
    } else out.push(m);
  }
  return out;
}

export async function runLoop(env: LoopEnv): Promise<LoopResult> {
  const msgs = normalize(transcripts.load<NeutralMessage>(env.owner));
  const push = (m: NeutralMessage) => {
    msgs.push(m);
    transcripts.append(env.owner, m);
  };
  if (!msgs.length) push({ role: 'user', content: env.brief() });

  const task = env.taskId ? taskDb.get(env.taskId) : undefined;
  const counters = { consults: task?.consults ?? 0, questions: task?.questions ?? 0 };
  const written: string[] = [];
  const seen = new Map<string, number>();
  for (const m of msgs) if (m.role === 'assistant') for (const c of m.toolCalls) seen.set(`${c.name}${stable(c.args)}`, (seen.get(`${c.name}${stable(c.args)}`) ?? 0) + 1);
  let steps = msgs.filter((m) => m.role === 'assistant').length;
  let repeats = 0;
  let idleTurns = 0;

  const saveCounters = () => {
    if (!env.taskId) return;
    const t = taskDb.get(env.taskId);
    if (!t) return;
    t.consults = counters.consults;
    t.questions = counters.questions;
    t.steps = steps;
    taskDb.put(t);
    broadcast({ kind: 'upsert', entity: 'task', data: t });
  };

  const execCall = async (call: ToolCall, agent: Agent, demo: boolean): Promise<{ result: ToolResult; final?: Final }> => {
    const err = (content: string) => ({ result: { id: call.id, name: call.name, content, isError: true } });
    const tool = TOOL_BY_NAME.get(call.name);
    if (!tool || !toolsFor(agent, env.phase).includes(tool)) return err(`Unknown or unavailable tool "${call.name}".`);
    if (call.invalidArgs) return err(`Your arguments were not valid JSON: ${call.invalidArgs.slice(0, 200)}`);
    const prepared = tool.prepare(call.args);
    if (!prepared.ok) return err(`Invalid arguments for ${call.name}: ${prepared.error}`);

    const sig = `${call.name}${stable(call.args)}`;
    const count = (seen.get(sig) ?? 0) + 1;
    seen.set(sig, count);
    if (count >= 3 && !REPEAT_OK.has(call.name)) {
      repeats++;
      log({ runId: env.runId, taskId: env.taskId, agentId: agent.id, type: 'loop_detected', level: 'warn', summary: `${agent.name} repeated the same ${call.name} call ${count} times`, data: { tool: call.name } });
      if (repeats >= 3) throw new Stuck(`${agent.name} kept repeating the same actions (${call.name}). Stopped to save budget.`);
      return err(`You already made this exact ${call.name} call ${count - 1} times. Use the earlier result or try something different.`);
    }

    setLive(agent.id, { activity: env.phase === 'plan' || env.phase === 'replan' ? 'planning' : 'working', detail: prepared.detail });

    if (tool.reach === 'external' && (tool.consequential || !agent.autoApprove.includes(tool.name))) {
      const { args } = prepared;
      const answer = await env.requestHuman(
        {
          runId: env.runId,
          taskId: env.taskId ?? null,
          agentId: agent.id,
          kind: 'approval',
          title: `${agent.name} wants to ${tool.label.toLowerCase()}`,
          body: String(args.reason ?? ''),
          options: ['Approve', 'Deny'],
          tool: tool.name,
          args,
          risk: tool.consequential ? 'Can change things outside this machine.' : 'Reads from the public internet. Page content is shown to the agent as untrusted data.',
        },
        env.signal,
      );
      if (!/^approve/i.test(answer)) {
        return err(`The Captain declined this request${answer && !/^deny$/i.test(answer) ? `: ${answer.replace(/^deny:?\s*/i, '')}` : '.'} Continue without it.`);
      }
    }

    const ctx: ToolCtx = {
      run: () => runs.must(env.runId),
      agent,
      task: env.taskId ? taskDb.get(env.taskId) : undefined,
      phase: env.phase,
      signal: env.signal,
      demo,
      written,
      counters,
      limits: env.limits,
      requestHuman: (req) => env.requestHuman(req, env.signal),
      consult: (target, q) => env.consult(agent, target, q, env.signal),
    };
    let out;
    try {
      out = await prepared.run(ctx);
    } catch (e) {
      if (e instanceof Cancelled || env.signal.aborted) throw e instanceof Cancelled ? e : new Cancelled();
      if (e instanceof TaskFailure) throw e;
      out = { content: `Tool failed: ${redact(e instanceof Error ? e.message : String(e))}`, isError: true };
    }
    log({
      runId: env.runId,
      taskId: env.taskId,
      agentId: agent.id,
      type: 'tool_call',
      level: 'debug',
      summary: `${agent.name} · ${call.name}${out.isError ? ' (error)' : ''}`,
      data: { tool: call.name, args: clipForLog(prepared.args), result: out.content.slice(0, 600), isError: !!out.isError },
    });
    saveCounters();
    return { result: { id: call.id, name: call.name, content: out.content, isError: out.isError }, final: out.isError ? undefined : out.final };
  };

  try {
    for (;;) {
      const last = msgs[msgs.length - 1];
      if (last.role === 'assistant' && last.toolCalls.length) {
        const agent = agents.must(env.agentId);
        const results: ToolResult[] = [];
        let final: Final | undefined;
        for (const call of last.toolCalls) {
          if (final !== undefined) {
            results.push({ id: call.id, name: call.name, content: 'Skipped: the task was already handed in.', isError: true });
            continue;
          }
          const r = await execCall(call, agent, !!last.demo);
          results.push(r.result);
          if (r.final !== undefined) final = r.final;
        }
        const notes = env.takeNotes().map((n) => `[Message from the Captain] ${n}`);
        if (final === undefined && steps === env.maxSteps - 1) notes.push('[System] You have one step left. Hand in now with what you have.');
        push({ role: 'user', content: notes.join('\n\n'), toolResults: results });
        if (final) return { kind: 'final', final };
        continue;
      }

      if (steps >= env.maxSteps) return { kind: 'blocked', reason: `Reached the limit of ${env.maxSteps} steps without finishing.` };
      // Never send a transcript that ends on an assistant turn (newer models treat it as a prefill and reject it).
      if (last.role === 'assistant') push({ role: 'user', content: '[System] Continue.' });
      await env.gate();

      const agent = agents.get(env.agentId);
      if (!agent) throw new TaskFailure('This crew member was removed.');
      const provider = getProvider(agent.providerId);
      if (!provider) throw new TaskFailure(`${agent.name} has no model assigned. Pick a provider and model in their settings, then retry.`);
      if (!agent.model) throw new TaskFailure(`${agent.name} has no model name set. Choose one in their settings, then retry.`);

      setLive(agent.id, { activity: env.phase === 'plan' || env.phase === 'replan' ? 'planning' : 'working', detail: 'thinking…', step: steps + 1, maxSteps: env.maxSteps, withAgentId: null, requestId: null });
      streamReset(agent.id, env.taskId ?? null);
      const started = Date.now();
      let resp: ChatResponse;
      try {
        resp = await provider.chat({
          model: agent.model,
          system: systemPrompt(agent, env.phase, env.maxSteps),
          messages: msgs,
          tools: toolsFor(agent, env.phase).map(specOf),
          effort: agent.effort,
          maxTokens: 16_000,
          signal: env.signal,
          onText: (d) => streamDelta(agent.id, env.taskId ?? null, 'text', d),
          onThinking: (d) => streamDelta(agent.id, env.taskId ?? null, 'thinking', d),
          hint: { phase: env.phase, agent, teammates: agents.all().filter((a) => a.enabled), ...env.hint() },
        });
      } catch (e) {
        if (env.signal.aborted) throw new Cancelled();
        if (e instanceof ProviderError) throw new TaskFailure(`${provider.label}: ${e.message}`);
        throw new TaskFailure(redact(e instanceof Error ? e.message : String(e)));
      }
      steps++;
      const cost = charge(env.runId, env.taskId, agent, resp);
      log({
        runId: env.runId,
        taskId: env.taskId,
        agentId: agent.id,
        type: 'model_call',
        level: 'debug',
        summary: `${agent.name} · ${resp.demo ? 'simulated step' : `${resp.model}`} · ${resp.usage.input + (resp.usage.cacheRead ?? 0) + (resp.usage.cacheWrite ?? 0)}→${resp.usage.output} tok${resp.usage.cacheRead ? ` (${resp.usage.cacheRead} cached)` : ''} · $${cost.toFixed(4)} · ${((Date.now() - started) / 1000).toFixed(1)}s`,
        data: { model: resp.model, usage: resp.usage, cost, stop: resp.stopReason, demo: !!resp.demo, text: resp.text.slice(0, 1200), calls: resp.toolCalls.map((c) => c.name) },
      });

      if (resp.stopReason === 'refusal') {
        throw new TaskFailure(`The model declined to continue${resp.refusalDetail ? ` (${resp.refusalDetail})` : ''}. Rephrase the task or try another model.`);
      }
      if (resp.stopReason === 'max_tokens' && resp.toolCalls.length) {
        push({ role: 'assistant', text: resp.text.slice(0, 4000), toolCalls: [], demo: resp.demo });
        push({ role: 'user', content: '[System] Your last response hit the output length limit and its tool call was cut off, so it was discarded. Split large content into several smaller artifacts.' });
        continue;
      }

      push({ role: 'assistant', text: resp.text, toolCalls: resp.toolCalls, raw: resp.raw ? { providerId: provider.id, model: agent.model, content: resp.raw } : undefined, demo: resp.demo });
      saveCounters();

      if (!resp.toolCalls.length) {
        idleTurns++;
        // Some models answer in plain text instead of calling tools. Keep that work
        // rather than losing it: save it as an artifact and hand it in.
        if (env.phase === 'task' && resp.text.trim().length > 400 && !written.length) {
          return {
            kind: 'final',
            final: { tool: 'finish_task', value: { autoSaveText: resp.text, summary: resp.text.trim().slice(0, 300), status: 'done', artifactIds: [], primary: null, notes: 'Saved automatically: the agent replied in text instead of calling finish_task.' } },
          };
        }
        if (idleTurns >= 3) return { kind: 'blocked', reason: `${agent.name} stopped using tools without handing in.` };
        const next = env.phase === 'plan' ? 'submit_plan' : env.phase === 'replan' ? 'revise_plan' : 'finish_task';
        push({ role: 'user', content: `[System] Continue by calling tools. When you're done, call ${next}.` });
      } else {
        idleTurns = 0;
      }
    }
  } catch (e) {
    if (e instanceof Stuck) return { kind: 'blocked', reason: e.message };
    throw e;
  }
}

function clipForLog(v: unknown): unknown {
  if (typeof v === 'string') return v.length > 400 ? `${v.slice(0, 400)}… (${v.length} chars)` : v;
  if (Array.isArray(v)) return v.slice(0, 20).map(clipForLog);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clipForLog(x)]));
  return v;
}
