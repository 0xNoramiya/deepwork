import type { Agent } from '../shared/types.ts';
import { agents, db, getSetting, setSetting } from './db.ts';
import { listProviders, syncEnvProviders } from './providers/index.ts';

type Seed = Omit<Agent, 'providerId' | 'model' | 'priceIn' | 'priceOut' | 'enabled' | 'maxSteps' | 'effort' | 'autoApprove'>;

const CREW: Seed[] = [
  {
    id: 'marlow',
    name: 'Marlow',
    title: 'Navigator',
    role: 'Leads missions: breaks the goal into tasks, assigns the crew, keeps work unblocked, and writes the final report.',
    persona: 'Decisive and economical. Prefers a few well-scoped tasks over many small ones. Writes final reports that stand on their own.',
    sprite: 'navigator',
    station: 'chart',
    color: '#27466e',
    tools: ['remember', 'ask_teammate'],
    isLead: true,
    sort: 0,
  },
  {
    id: 'ines',
    name: 'Ines',
    title: 'Researcher',
    role: 'Finds and checks information: background research, sources, facts, comparisons and prior art.',
    persona: 'Cite sources. Keep what you verified separate from what you assume. Summarise before you elaborate.',
    sprite: 'sonar',
    station: 'sonar',
    color: '#2f7f7a',
    tools: ['remember', 'ask_teammate', 'web_fetch'],
    isLead: false,
    sort: 1,
  },
  {
    id: 'bo',
    name: 'Bo',
    title: 'Engineer',
    role: 'Builds things: code, data models, technical designs, specs, calculations and prototypes.',
    persona: 'Working code over pseudo-code. State assumptions and explain how to run or use what you build.',
    sprite: 'engineer',
    station: 'workshop',
    color: '#d4583f',
    tools: ['remember', 'ask_teammate', 'web_fetch'],
    isLead: false,
    sort: 2,
  },
  {
    id: 'wren',
    name: 'Wren',
    title: 'Writer',
    role: 'Turns findings into clear documents: drafts, summaries, documentation, copy and messages.',
    persona: 'Plain language, short sentences, concrete examples. Structure for skimming.',
    sprite: 'writer',
    station: 'cabin',
    color: '#c98e1e',
    tools: ['remember', 'ask_teammate'],
    isLead: false,
    sort: 3,
  },
  {
    id: 'juno',
    name: 'Juno',
    title: 'Inspector',
    role: 'Reviews work against the goal and acceptance criteria. Catches errors, gaps, weak claims and unclear writing.',
    persona: 'Be specific: point at the exact problem and propose the fix. Sign off only when it is actually good.',
    sprite: 'inspector',
    station: 'lab',
    color: '#8d3b4a',
    tools: ['remember', 'ask_teammate'],
    isLead: false,
    sort: 4,
  },
];

/** Picks the first real provider that is ready, or the demo provider. */
function preferredProvider(): { providerId: string; model: string } {
  const ready = listProviders().filter((p) => p.kind !== 'demo' && (p.keySource !== 'none' || /localhost/.test(p.baseUrl ?? '')) && p.defaultModel);
  const pick = ready.find((p) => p.kind === 'anthropic') ?? ready[0];
  return pick ? { providerId: pick.id, model: pick.defaultModel } : { providerId: 'demo', model: 'simulated' };
}

export function seed() {
  syncEnvProviders();
  const count = (db.prepare('SELECT COUNT(*) AS n FROM agents').get() as { n: number }).n;
  if (count === 0) {
    const { providerId, model } = preferredProvider();
    for (const c of CREW) {
      agents.put({ ...c, providerId, model, effort: 'medium', maxSteps: 14, autoApprove: [], enabled: true, priceIn: null, priceOut: null });
    }
  }
  if (getSetting<string | null>('charter', null) === null) {
    setSetting(
      'charter',
      'Write in plain English. Prefer concrete, actionable output over long background.\nWhen something is uncertain, say so and move on rather than stalling.',
    );
  }
}

