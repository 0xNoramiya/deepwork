// End-to-end engine test in demo mode: plan → parallel tasks → question → approval
// (denied, so no network is needed) → consult → synthesis → persisted artifacts.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deepwork-test-'));
process.env.DEEPWORK_DATA_DIR = path.join(tmp, 'data');
process.env.DEEPWORK_WORKSPACE_DIR = path.join(tmp, 'workspace');
process.env.DEEPWORK_DEMO_SPEED = '0';
for (const k of Object.keys(process.env)) if (/_API_KEY$/.test(k)) delete process.env[k];

const { seed } = await import('../seed.ts');
const { orchestrator } = await import('../engine/orchestrator.ts');
const db = await import('../db.ts');

seed();

async function until<T>(fn: () => T | undefined | false, what: string, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

test('a demo mission runs end to end with real coordination', async () => {
  assert.ok(db.agents.all().every((a) => a.providerId === 'demo'), 'no keys → crew on demo provider');
  const run = orchestrator.startRun('Write a one-page guide to brewing good coffee at home', { requirePlanApproval: true, budgetUsd: 1 });

  // Plan review gate
  await until(() => db.runs.get(run.id)?.status === 'review', 'plan review');
  const plan = db.tasks.byRun(run.id);
  assert.equal(plan.length, 4);
  assert.ok(plan.some((t) => t.dependsOn.length === 2), 'draft depends on two parallel tasks');
  orchestrator.launch(run.id);

  // Answer everything the crew asks: deny web access, pick the first option otherwise.
  const seenKinds = new Set<string>();
  const answerer = setInterval(() => {
    for (const q of db.requests.open()) {
      seenKinds.add(q.kind);
      try {
        orchestrator.resolve(q.id, q.kind === 'approval' ? 'Deny' : q.options[0] ?? 'OK');
      } catch {}
    }
  }, 30);

  // Parallelism: research and blueprint should be running at the same time.
  await until(() => db.tasks.byRun(run.id).filter((t) => t.status === 'running' || t.status === 'waiting_approval').length >= 2, 'two tasks in parallel');

  const done = await until(() => {
    const r = db.runs.get(run.id)!;
    return ['completed', 'failed', 'cancelled'].includes(r.status) && r;
  }, 'mission completion', 30_000);
  clearInterval(answerer);

  assert.equal(done.status, 'completed', done.error ?? '');
  assert.ok(done.demo, 'run is flagged as simulated');
  assert.ok(seenKinds.has('approval'), 'an external action asked for approval');
  assert.ok(seenKinds.has('question'), 'an agent asked the Captain a question');
  const tasks = db.tasks.byRun(run.id);
  assert.ok(tasks.every((t) => t.status === 'done'), JSON.stringify(tasks.map((t) => [t.key, t.status, t.error])));

  const arts = db.artifacts.byRun(run.id);
  const final = arts.find((a) => a.id === done.finalArtifactId);
  assert.ok(final, 'final artifact recorded');
  assert.ok(final!.demo, 'artifacts from the demo are flagged');
  assert.match(db.artifacts.content(final!.id)!, /Simulated output/);
  assert.ok(fs.existsSync(path.join(process.env.DEEPWORK_WORKSPACE_DIR!, final!.path)), 'artifact written to disk');

  const events = db.events.recent(run.id, 2000).map((e) => e.type);
  for (const t of ['handoff', 'consult_start', 'consult_answer', 'approval_denied', 'memory_written', 'run_completed']) assert.ok(events.includes(t), `event ${t}`);
  assert.ok(db.memories.search('coffee').length > 0, 'mission logged to memory for next time');
});

test('the budget stops work before the next model call', async () => {
  const run = orchestrator.startRun('Plan a tiny garden', { requirePlanApproval: false, budgetUsd: 0.01 });
  // Force spend over the limit, then let the gate trip.
  const r = db.runs.get(run.id)!;
  r.spentUsd = 0.02;
  db.runs.put(r);
  const paused = await until(() => {
    const x = db.runs.get(run.id)!;
    return x.status === 'paused' && x;
  }, 'budget pause');
  assert.match(paused.pauseReason ?? '', /Budget/);
  assert.ok(db.requests.open().some((q) => q.kind === 'budget' && q.runId === run.id));
  assert.throws(() => orchestrator.resume(run.id), /budget/i);
  orchestrator.cancel(run.id);
  assert.equal(db.runs.get(run.id)!.status, 'cancelled');
});

test('plan validation rejects cycles and unknown crew', async () => {
  const { validatePlan } = await import('../engine/plan.ts');
  const t = (key: string, deps: string[], who = 'Ines') => ({ key, title: key, description: '', assignee: who, depends_on: deps, acceptance: '' });
  assert.match(validatePlan({ tasks: [t('a', ['b']), t('b', ['a'])] }, 6)!, /cycle/);
  assert.match(validatePlan({ tasks: [t('a', [], 'Nobody')] }, 6)!, /no crew member/);
  assert.equal(validatePlan({ tasks: [t('a', []), t('b', ['a'])] }, 6), null);
});

test('the Captain can hold an agent and redirect one mid-task', async () => {
  const run = orchestrator.startRun('Draft a packing list for a weekend hike', { requirePlanApproval: true, budgetUsd: 1 });
  await until(() => db.runs.get(run.id)?.status === 'review', 'plan review');
  const plan = db.tasks.byRun(run.id);
  const research = plan.find((t) => t.key === 'research')!;
  const blueprint = plan.find((t) => t.key === 'blueprint')!;

  // Hold the researcher before launch: their task must not start while held.
  orchestrator.hold(research.assigneeId, true);
  orchestrator.launch(run.id);
  const answerer = setInterval(() => {
    for (const q of db.requests.open()) {
      try {
        orchestrator.resolve(q.id, q.kind === 'approval' ? 'Deny' : q.options[0] ?? 'OK');
      } catch {}
    }
  }, 20);
  await until(() => db.tasks.get(blueprint.id)?.status === 'running', 'blueprint running');
  assert.equal(db.tasks.get(research.id)!.status, 'pending', 'held agent does not start');

  // Redirect the engineer while they work; the note must reach their transcript.
  await orchestrator.chat(blueprint.assigneeId, 'Keep it to ten items.', 'redirect');
  await until(() => db.transcripts.load<{ content?: string }>(blueprint.id).some((m) => m.content?.includes('[Message from the Captain] Keep it to ten items.')), 'redirect delivered');

  orchestrator.hold(research.assigneeId, false);
  const done = await until(() => {
    const r = db.runs.get(run.id)!;
    return ['completed', 'failed'].includes(r.status) && r;
  }, 'completion', 30_000);
  clearInterval(answerer);
  assert.equal(done.status, 'completed');
  assert.ok(db.events.recent(run.id, 2000).some((e) => e.type === 'redirect_delivered'));
});
