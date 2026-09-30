import type { Agent } from '../../shared/types.ts';

// $ per million tokens [input, output]. Anthropic rates are first-party list prices
// (Sept 2026). Everything else is a best-effort estimate; per-agent overrides win.
const TABLE: [RegExp, number, number][] = [
  [/claude-(fable|mythos)-5/, 10, 50],
  [/claude-opus-5-5/, 4, 20],
  [/claude-opus-(5|4-[5-8])/, 5, 25],
  [/claude-sonnet-5/, 2, 10],
  [/claude-sonnet-4/, 3, 15],
  [/claude-haiku-4/, 1, 5],
  [/gpt-5.*mini/, 0.25, 2],
  [/gpt-5.*nano/, 0.05, 0.4],
  [/gpt-5/, 1.25, 10],
  [/gpt-4\.1-mini/, 0.4, 1.6],
  [/gpt-4\.1/, 2, 8],
  [/gpt-4o-mini/, 0.15, 0.6],
  [/gpt-4o/, 2.5, 10],
  [/gemini.*flash/, 0.3, 2.5],
  [/gemini.*pro/, 1.25, 10],
];

const FALLBACK: [number, number] = [3, 15];

export function priceFor(agent: Pick<Agent, 'model' | 'priceIn' | 'priceOut'>, providerKind: string, baseUrl: string | null) {
  if (providerKind === 'demo') return { input: 0, output: 0, estimated: false };
  const local = !!baseUrl && /localhost|127\.0\.0\.1|0\.0\.0\.0/.test(baseUrl);
  if (local && agent.priceIn == null && agent.priceOut == null) return { input: 0, output: 0, estimated: false };
  const hit = TABLE.find(([re]) => re.test(agent.model));
  const [i, o] = hit ? [hit[1], hit[2]] : FALLBACK;
  return {
    input: agent.priceIn ?? i,
    output: agent.priceOut ?? o,
    estimated: !hit && agent.priceIn == null,
  };
}

/** Cache writes cost 1.25× the input rate and cache reads 0.1× (Anthropic's 5-minute cache; a fair estimate elsewhere). */
export function costOf(usage: { input: number; output: number; cacheRead?: number; cacheWrite?: number }, price: { input: number; output: number }) {
  const input = usage.input + (usage.cacheWrite ?? 0) * 1.25 + (usage.cacheRead ?? 0) * 0.1;
  return (input * price.input + usage.output * price.output) / 1_000_000;
}
