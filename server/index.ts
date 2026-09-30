import express, { type NextFunction, type Request, type Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import type { Agent, Snapshot } from '../shared/types.ts';
import { agents, artifacts, chats, DATA_DIR, events, getSetting, memories, requests, ROOT, runs, setSetting, tasks, transcripts, WORKSPACE_DIR } from './db.ts';
import { broadcast, log, subscribe } from './bus.ts';
import { getLive, resetLive } from './engine/live.ts';
import { orchestrator } from './engine/orchestrator.ts';
import { DEFAULT_LIMITS } from '../shared/defaults.ts';
import { saveMemory, toolCatalog, CONFIGURABLE } from './engine/tools.ts';
import { addProvider, getProvider, listProviders, PRESETS, removeProvider, updateProvider } from './providers/index.ts';
import type { NeutralMessage } from './providers/types.ts';
import { ProviderError } from './providers/types.ts';
import { redact } from './secrets.ts';
import { seed } from './seed.ts';

const PORT = Number(process.env.PORT ?? 5174);
const HOST = process.env.HOST ?? '127.0.0.1';
const PROD = process.env.NODE_ENV === 'production';

const START = Date.now();

seed();
orchestrator.recover();

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const app = express();
app.disable('x-powered-by');

// DNS-rebinding guard: only answer to the names this server is actually reached by.
const allowedHosts = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`, ...(process.env.ALLOWED_HOSTS?.split(',') ?? [])]);
app.use((req, res, next) => {
  if (!allowedHosts.has(req.headers.host ?? '')) return res.status(421).send('Unexpected Host header');
  next();
});
// CSRF guard: state-changing calls must carry a custom header, which a foreign page
// can only send after a CORS preflight that this server never approves.
app.use('/api', (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  if (req.headers['x-deepwork'] !== '1') return res.status(403).json({ error: 'Missing x-deepwork header' });
  const origin = req.headers.origin;
  if (origin && !allowedHosts.has(origin.replace(/^https?:\/\//, ''))) return res.status(403).json({ error: 'Cross-origin request refused' });
  next();
});
app.use(express.json({ limit: '1mb' }));

type H = (req: Request, res: Response) => unknown;
const wrap = (fn: H) => async (req: Request, res: Response, next: NextFunction) => {
  try {
    const out = await fn(req, res);
    if (!res.headersSent) res.json(out ?? { ok: true });
  } catch (e) {
    next(e);
  }
};
const param = (req: Request, k: string) => String(req.params[k]);

function currentRun() {
  return runs.active() ?? runs.recent(1)[0] ?? null;
}

function snapshot(): Snapshot {
  const run = currentRun();
  const crew = agents.all();
  return {
    agents: crew,
    live: crew.map((a) => getLive(a.id)),
    providers: listProviders(),
    run,
    runs: runs.recent(30),
    tasks: run ? tasks.byRun(run.id) : [],
    artifacts: artifacts.recent(300),
    requests: [...new Map([...requests.open(), ...(run ? requests.byRun(run.id) : [])].map((q) => [q.id, q])).values()],
    events: events.recent(run?.id ?? null, 500),
    memories: memories.all(300),
    charter: getSetting('charter', ''),
    defaults: { ...DEFAULT_LIMITS, ...getSetting('limits', {}) },
    toolCatalog: toolCatalog(),
  };
}

app.get('/api/state', wrap(() => ({ ...snapshot(), held: orchestrator.heldAgents(), presets: PRESETS, configurableTools: CONFIGURABLE })));

app.get('/api/stream', (req, res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  res.write(`data: ${JSON.stringify({ kind: 'hello', serverStart: START })}\n\n`);
  subscribe(res);
  const beat = setInterval(() => res.write(': ping\n\n'), 20_000);
  req.on('close', () => clearInterval(beat));
});

const limitsSchema = z
  .object({
    budgetUsd: z.number().min(0.01).max(1000),
    maxTokens: z.number().int().min(1000).max(100_000_000),
    maxTasks: z.number().int().min(1).max(12),
    maxStepsPerTask: z.number().int().min(2).max(60),
    maxConsultsPerTask: z.number().int().min(0).max(10),
    maxQuestionsPerTask: z.number().int().min(0).max(10),
    maxReplans: z.number().int().min(0).max(5),
    concurrency: z.number().int().min(1).max(8),
    requirePlanApproval: z.boolean(),
  })
  .partial();

app.post(
  '/api/runs',
  wrap((req) => {
    const body = z.object({ goal: z.string().min(3).max(4000), limits: limitsSchema.default({}) }).parse(req.body);
    return orchestrator.startRun(body.goal, body.limits);
  }),
);
app.get(
  '/api/runs/:id',
  wrap((req) => {
    const run = runs.get(param(req, 'id'));
    if (!run) throw new HttpError(404, 'No such mission');
    return { run, tasks: tasks.byRun(run.id), artifacts: artifacts.byRun(run.id), requests: requests.byRun(run.id), events: events.recent(run.id, 800) };
  }),
);
app.post('/api/runs/:id/launch', wrap((req) => orchestrator.launch(param(req, 'id'))));
app.post('/api/runs/:id/pause', wrap((req) => orchestrator.pause(param(req, 'id'))));
app.post('/api/runs/:id/resume', wrap((req) => orchestrator.resume(param(req, 'id'))));
app.post('/api/runs/:id/cancel', wrap((req) => orchestrator.cancel(param(req, 'id'))));
app.post('/api/runs/:id/wrapup', wrap((req) => orchestrator.wrapUp(param(req, 'id'))));
app.patch('/api/runs/:id/limits', wrap((req) => orchestrator.setLimits(param(req, 'id'), limitsSchema.parse(req.body))));
app.put(
  '/api/settings/limits',
  wrap((req) => {
    setSetting('limits', limitsSchema.parse(req.body));
    return { ...DEFAULT_LIMITS, ...getSetting('limits', {}) };
  }),
);

app.patch(
  '/api/tasks/:id',
  wrap((req) =>
    orchestrator.editTask(
      param(req, 'id'),
      z.object({ title: z.string().min(1).max(140), description: z.string().max(6000), acceptance: z.string().max(2000), assigneeId: z.string(), dependsOn: z.array(z.string()) }).partial().parse(req.body),
    ),
  ),
);
app.delete('/api/tasks/:id', wrap((req) => orchestrator.removeTask(param(req, 'id'))));
app.post('/api/tasks/:id/stop', wrap((req) => orchestrator.stopTask(param(req, 'id'))));
app.post('/api/tasks/:id/retry', wrap((req) => orchestrator.retryTask(param(req, 'id'), z.object({ note: z.string().max(3000).optional() }).parse(req.body ?? {}).note)));
app.post('/api/tasks/:id/skip', wrap((req) => orchestrator.skipTask(param(req, 'id'))));
app.get(
  '/api/transcripts/:owner',
  wrap((req) => {
    // Raw provider blocks stay on the server; the inspector gets text, tool calls and thinking summaries.
    return transcripts.load<NeutralMessage>(param(req, 'owner')).map((m) => {
      if (m.role === 'user') return m;
      const raw = (m.raw?.content ?? []) as { type: string; thinking?: string }[];
      const thinking = Array.isArray(raw) ? raw.filter((b) => b.type === 'thinking' && b.thinking).map((b) => b.thinking).join('\n\n') : '';
      return { role: 'assistant', text: m.text, toolCalls: m.toolCalls, thinking, demo: !!m.demo };
    });
  }),
);

app.post('/api/requests/:id/resolve', wrap((req) => orchestrator.resolve(param(req, 'id'), z.object({ response: z.string().min(1).max(4000) }).parse(req.body).response)));

app.get(
  '/api/artifacts/:id',
  wrap((req) => {
    const a = artifacts.get(param(req, 'id'));
    if (!a) throw new HttpError(404, 'No such artifact');
    return { artifact: a, content: artifacts.content(a.id) ?? '' };
  }),
);
app.get('/api/artifacts/:id/download', (req, res) => {
  const a = artifacts.get(param(req, 'id'));
  if (!a) return res.status(404).end();
  res.setHeader('content-disposition', `attachment; filename="${path.basename(a.path)}"`);
  res.type('text/plain').send(artifacts.content(a.id) ?? '');
});
// HTML artifacts are served for a sandboxed iframe with a CSP that blocks network access.
app.get('/api/artifacts/:id/preview', (req, res) => {
  const a = artifacts.get(param(req, 'id'));
  if (!a || a.kind !== 'html') return res.status(404).end();
  res.setHeader('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'unsafe-inline'; sandbox allow-scripts");
  res.type('html').send(artifacts.content(a.id) ?? '');
});

const agentSchema = z.object({
  name: z.string().min(1).max(30),
  title: z.string().min(1).max(40),
  role: z.string().min(3).max(600),
  persona: z.string().max(2000),
  sprite: z.enum(['navigator', 'sonar', 'writer', 'engineer', 'inspector', 'deckhand', 'quartermaster']),
  station: z.enum(['chart', 'sonar', 'cabin', 'lab', 'workshop', 'engine', 'archive', 'galley', 'radio', 'bridge']),
  color: z.string().regex(/^#[0-9a-f]{6}$/i),
  providerId: z.string().nullable(),
  model: z.string().max(120),
  effort: z.enum(['low', 'medium', 'high']),
  maxSteps: z.number().int().min(2).max(60),
  tools: z.array(z.enum(CONFIGURABLE)),
  autoApprove: z.array(z.enum(['web_fetch'])),
  isLead: z.boolean(),
  enabled: z.boolean(),
  priceIn: z.number().min(0).max(500).nullable(),
  priceOut: z.number().min(0).max(500).nullable(),
});

function assertNoActiveWork(agentId: string) {
  const run = runs.active();
  if (run && tasks.byRun(run.id).some((t) => t.assigneeId === agentId && ['running', 'waiting_user', 'waiting_approval'].includes(t.status))) {
    throw new Error('This crew member is mid-task. Pause the mission or wait for the task to finish.');
  }
}

function putAgent(a: Agent) {
  agents.put(a);
  broadcast({ kind: 'upsert', entity: 'agent', data: a });
  if (!a.isLead) return;
  // There is exactly one lead.
  for (const other of agents.all()) {
    if (other.id === a.id || !other.isLead) continue;
    const demoted = { ...other, isLead: false };
    agents.put(demoted);
    broadcast({ kind: 'upsert', entity: 'agent', data: demoted });
  }
}

app.post(
  '/api/agents',
  wrap((req) => {
    const body = agentSchema.parse(req.body);
    const id = `${body.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${nanoid(4)}`;
    const a: Agent = { ...body, id, sort: agents.all().length };
    putAgent(a);
    resetLive(id, a.enabled ? 'idle' : 'off_duty');
    log({ runId: runs.active()?.id, agentId: id, type: 'agent_hired', level: 'important', summary: `${a.name} joined the crew as ${a.title}` });
    return a;
  }),
);
app.patch(
  '/api/agents/:id',
  wrap((req) => {
    const cur = agents.get(param(req, 'id'));
    if (!cur) throw new HttpError(404, 'No such crew member');
    const patch = agentSchema.partial().parse(req.body);
    if (patch.enabled === false) {
      assertNoActiveWork(cur.id);
      const run = runs.active();
      if (run && tasks.byRun(run.id).some((t) => t.assigneeId === cur.id && t.status === 'pending')) throw new Error('Reassign their queued tasks before taking them off duty.');
    }
    const next = { ...cur, ...patch };
    putAgent(next);
    if (patch.enabled !== undefined) resetLive(cur.id, next.enabled ? 'idle' : 'off_duty');
    orchestrator.tick();
    return next;
  }),
);
app.delete(
  '/api/agents/:id',
  wrap((req) => {
    const id = param(req, 'id');
    const a = agents.get(id);
    if (!a) return;
    if (a.isLead) throw new Error('Pick another lead before removing this crew member.');
    assertNoActiveWork(id);
    const run = runs.active();
    if (run && tasks.byRun(run.id).some((t) => t.assigneeId === id && t.status === 'pending')) throw new Error('Reassign their pending tasks first.');
    agents.remove(id);
    broadcast({ kind: 'remove', entity: 'agent', id });
  }),
);
app.post('/api/agents/:id/hold', wrap((req) => orchestrator.hold(param(req, 'id'), z.object({ on: z.boolean() }).parse(req.body).on)));
app.get('/api/agents/:id/chat', wrap((req) => chats.byAgent(param(req, 'id'))));
app.post(
  '/api/agents/:id/chat',
  wrap(async (req) => {
    const body = z.object({ text: z.string().min(1).max(4000), mode: z.enum(['ask', 'redirect']) }).parse(req.body);
    if (!agents.get(param(req, 'id'))) throw new HttpError(404, 'No such crew member');
    // The reply streams over SSE; this request only confirms the message was accepted.
    void orchestrator.chat(param(req, 'id'), body.text, body.mode).catch((e) => console.error('chat failed:', redact(String(e))));
    return { ok: true };
  }),
);

app.post(
  '/api/providers',
  wrap((req) => {
    const body = z
      .object({ kind: z.enum(['anthropic', 'openai', 'openai_compat']), label: z.string().min(1).max(60), baseUrl: z.string().url().nullable().or(z.literal('')), apiKey: z.string().max(400).nullable(), defaultModel: z.string().max(120) })
      .parse(req.body);
    const p = addProvider({ ...body, baseUrl: body.baseUrl || null });
    broadcast({ kind: 'upsert', entity: 'provider', data: p });
    return p;
  }),
);
app.patch(
  '/api/providers/:id',
  wrap((req) => {
    const body = z.object({ label: z.string().min(1).max(60), baseUrl: z.string().url().nullable().or(z.literal('')), apiKey: z.string().min(1).max(400), defaultModel: z.string().max(120) }).partial().parse(req.body);
    const p = updateProvider(param(req, 'id'), body);
    broadcast({ kind: 'upsert', entity: 'provider', data: p });
    return p;
  }),
);
app.delete(
  '/api/providers/:id',
  wrap((req) => {
    const id = param(req, 'id');
    if (agents.all().some((a) => a.providerId === id)) throw new Error('Some crew members still use this provider. Switch them first.');
    removeProvider(id);
    broadcast({ kind: 'remove', entity: 'provider', id });
  }),
);
app.post(
  '/api/providers/:id/test',
  wrap(async (req) => {
    const p = getProvider(param(req, 'id'));
    if (!p) throw new HttpError(404, 'No such provider');
    try {
      const models = await Promise.race([p.listModels(), new Promise<never>((_, rej) => setTimeout(() => rej(new ProviderError('Timed out after 15s', true)), 15_000))]);
      return { ok: true, models: models.slice(0, 400) };
    } catch (e) {
      return { ok: false, error: e instanceof ProviderError ? e.message : redact(String(e)) };
    }
  }),
);
app.post(
  '/api/providers/:id/assign',
  wrap((req) => {
    const body = z.object({ model: z.string().min(1).max(120), agentIds: z.array(z.string()).optional() }).parse(req.body);
    const id = param(req, 'id');
    if (id !== 'demo' && !listProviders().some((p) => p.id === id)) throw new Error('No such provider');
    for (const a of agents.all()) {
      if (body.agentIds && !body.agentIds.includes(a.id)) continue;
      putAgent({ ...a, providerId: id, model: body.model });
    }
  }),
);

app.post(
  '/api/memories',
  wrap((req) => {
    const b = z.object({ content: z.string().min(2).max(2000), tags: z.string().max(200).default(''), pinned: z.boolean().default(false) }).parse(req.body);
    return saveMemory({ scope: 'shared', agentId: null, runId: runs.active()?.id ?? null, content: b.content, tags: b.tags, source: 'the Captain', pinned: b.pinned, demo: false });
  }),
);
app.patch(
  '/api/memories/:id',
  wrap((req) => {
    const m = memories.get(param(req, 'id'));
    if (!m) throw new HttpError(404, 'No such memory');
    const b = z.object({ content: z.string().min(2).max(2000), pinned: z.boolean(), tags: z.string().max(200) }).partial().parse(req.body);
    const next = { ...m, ...b };
    memories.put(next);
    broadcast({ kind: 'upsert', entity: 'memory', data: next });
    return next;
  }),
);
app.delete(
  '/api/memories/:id',
  wrap((req) => {
    memories.remove(param(req, 'id'));
    broadcast({ kind: 'remove', entity: 'memory', id: param(req, 'id') });
  }),
);
app.put(
  '/api/charter',
  wrap((req) => {
    const text = z.object({ text: z.string().max(8000) }).parse(req.body).text;
    setSetting('charter', text);
    broadcast({ kind: 'charter', data: text });
  }),
);

app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const status = err instanceof HttpError ? err.status : 400;
  const message = err instanceof z.ZodError ? err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') : err instanceof Error ? err.message : String(err);
  res.status(status).json({ error: redact(message) });
});

if (PROD) {
  const dist = path.join(ROOT, 'dist');
  if (!fs.existsSync(dist)) {
    console.error('No build found. Run `npm run build` first.');
    process.exit(1);
  }
  app.use(express.static(dist, { index: false, maxAge: '1h' }));
  app.use((_req, res) => res.sendFile(path.join(dist, 'index.html')));
} else {
  const { createServer } = await import('vite');
  const vite = await createServer({ root: ROOT, server: { middlewareMode: true, hmr: { port: PORT + 1000 } }, appType: 'spa' });
  app.use(vite.middlewares);
}

app.listen(PORT, HOST, () => {
  const demoOnly = listProviders().every((p) => p.kind === 'demo' || p.keySource === 'none');
  console.log(`\n  Deepwork is surfacing at http://localhost:${PORT}\n`);
  const rel = (p: string) => (p.startsWith(ROOT) ? path.relative(ROOT, p) || '.' : p);
  console.log(`  Data:      ${rel(DATA_DIR)}/ (database, encrypted keys)`);
  console.log(`  Artifacts: ${rel(WORKSPACE_DIR)}/`);
  console.log(demoOnly ? '  Mode:      DEMO. No provider keys found; the crew runs on simulated output.\n' : '  Mode:      live providers available.\n');
  if (HOST !== '127.0.0.1' && HOST !== 'localhost') console.warn(`  Warning: listening on ${HOST}. Anyone who can reach it can spend your API budget.\n`);
});
