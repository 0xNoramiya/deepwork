import { EventEmitter } from 'node:events';
import { nanoid } from 'nanoid';
import type { Agent, ChatMessage, DecisionRequest, Run, RunLimits, Task } from '../../shared/types.ts';
import { agents, artifacts, chats, getSetting, requests, runs, tasks as taskDb, transcripts } from '../db.ts';
import { broadcast, log, streamDelta, streamReset } from '../bus.ts';
import { getProvider } from '../providers/index.ts';
import type { NeutralMessage } from '../providers/types.ts';
import { ProviderError } from '../providers/types.ts';
import { redact } from '../secrets.ts';
import { getLive, resetLive, setLive } from './live.ts';
import { Cancelled, charge, runLoop, TaskFailure, type LoopEnv } from './loop.ts';
import { consultContext, planBrief, replanBrief, synthBrief, systemPrompt, taskBrief } from './prompts.ts';
import { findAgentByName, type PlanTask } from './plan.ts';
import { saveArtifact, saveMemory, type Final, type Handin, type Revision } from './tools.ts';
import { DEFAULT_LIMITS } from '../../shared/defaults.ts';

const TERMINAL_RUN = new Set(['completed', 'failed', 'cancelled']);
const TASK_OK = new Set(['done', 'skipped']);
const TASK_ACTIVE = new Set(['running', 'waiting_user', 'waiting_approval']);


function pubRun(r: Run) {
  broadcast({ kind: 'upsert', entity: 'run', data: r });
}
function pubTask(t: Task) {
  broadcast({ kind: 'upsert', entity: 'task', data: t });
}
function pubRequest(q: DecisionRequest) {
  broadcast({ kind: 'upsert', entity: 'request', data: q });
}

/** The phase decides which tool can end its loop; anything else means the loop broke its contract. */
const wrongEnd = (f: Final, expected: Final['tool']) => new Error(`Expected ${expected} to end this phase, got ${f.tool}`);


class Orchestrator {
  private inflight = new Map<string, AbortController>();
  private phase: { runId: string; kind: 'plan' | 'synth' | 'replan'; ac: AbortController } | null = null;
  private held = new Set<string>();
  private notes = new Map<string, string[]>();
  private waiters = new Map<string, (answer: string) => void>();
  private wake = new EventEmitter();
  private warned = new Set<string>();

  constructor() {
    this.wake.setMaxListeners(200);
  }


  /** After a restart, nothing is in flight. Park the active run so the Captain decides when to continue. */
  recover() {
    const run = runs.active();
    for (const q of requests.open()) {
      if (q.kind === 'question' || q.kind === 'approval') {
        q.status = 'expired';
        q.resolvedAt = Date.now();
        requests.put(q);
      }
    }
    if (!run) return;
    for (const t of taskDb.byRun(run.id)) {
      if (TASK_ACTIVE.has(t.status)) {
        t.status = 'pending';
        taskDb.put(t);
      }
    }
    if (run.status === 'running' || run.status === 'planning' || run.status === 'synthesizing') {
      this.update(run.id, (r) => {
        r.pausedFrom = r.status;
        r.status = 'paused';
        r.pauseReason = 'The server restarted. Resume to continue where the crew left off.';
      });
      log({ runId: run.id, type: 'run_paused', level: 'warn', summary: 'Server restarted; mission paused' });
    }
  }


  private update(runId: string, fn: (r: Run) => void): Run {
    const r = runs.must(runId);
    fn(r);
    r.updatedAt = Date.now();
    runs.put(r);
    pubRun(r);
    return r;
  }

  private updateTask(taskId: string, fn: (t: Task) => void): Task {
    const t = taskDb.must(taskId);
    fn(t);
    taskDb.put(t);
    pubTask(t);
    return t;
  }

  private waitForWake(signal: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
      const onWake = () => {
        cleanup();
        resolve();
      };
      const onAbort = () => {
        cleanup();
        reject(new Cancelled());
      };
      const cleanup = () => {
        this.wake.off('wake', onWake);
        signal.removeEventListener('abort', onAbort);
      };
      this.wake.on('wake', onWake);
      signal.addEventListener('abort', onAbort);
    });
  }

  private notify() {
    this.wake.emit('wake');
  }

  private lead(): Agent {
    const all = agents.all().filter((a) => a.enabled);
    const lead = all.find((a) => a.isLead) ?? all[0];
    if (!lead) throw new Error('The crew is empty. Add at least one crew member.');
    return lead;
  }

  private overBudget(r: Run) {
    return r.spentUsd >= r.limits.budgetUsd || r.tokensIn + r.tokensOut >= r.limits.maxTokens;
  }

  /** Waits while the run is paused or the agent is held; enforces the budget before every model call. */
  private async gate(runId: string, agentId: string, signal: AbortSignal) {
    for (;;) {
      if (signal.aborted) throw new Cancelled();
      const r = runs.get(runId);
      if (!r || r.status === 'cancelled') throw new Cancelled();
      if (r.status !== 'paused' && this.overBudget(r)) this.pauseForBudget(r);
      else if (r.status !== 'paused' && r.spentUsd >= r.limits.budgetUsd * 0.8 && !this.warned.has(r.id)) {
        this.warned.add(r.id);
        log({ runId, type: 'budget_warning', level: 'warn', summary: `80% of the budget used ($${r.spentUsd.toFixed(2)} of $${r.limits.budgetUsd.toFixed(2)})` });
      }
      const now = runs.must(runId);
      if (now.status === 'paused' || this.held.has(agentId)) {
        const prev = getLive(agentId);
        setLive(agentId, { activity: 'paused', detail: this.held.has(agentId) ? 'held by the Captain' : (now.pauseReason ?? 'mission paused') });
        await this.waitForWake(signal);
        setLive(agentId, { activity: prev.activity === 'paused' ? 'working' : prev.activity, detail: prev.detail });
        continue;
      }
      return;
    }
  }

  private pauseForBudget(r: Run) {
    const reason = `Budget reached: $${r.spentUsd.toFixed(2)} of $${r.limits.budgetUsd.toFixed(2)}, ${(r.tokensIn + r.tokensOut).toLocaleString()} tokens.`;
    this.update(r.id, (x) => {
      x.pausedFrom = x.status === 'paused' ? x.pausedFrom : x.status;
      x.status = 'paused';
      x.pauseReason = reason;
    });
    log({ runId: r.id, type: 'budget_exhausted', level: 'warn', summary: reason });
    if (!requests.byRun(r.id).some((q) => q.kind === 'budget' && q.status === 'open')) {
      this.createRequest({
        runId: r.id,
        taskId: null,
        agentId: null,
        kind: 'budget',
        title: 'The mission has used its budget',
        body: `${reason} Work stops before the next model call. Agents already mid-call may finish that one call.`,
        options: ['Add 50% more budget', 'Wrap up with what we have', 'Cancel mission'],
        tool: null,
        args: null,
        risk: null,
      });
    }
  }

  private createRequest(input: Omit<DecisionRequest, 'id' | 'status' | 'response' | 'createdAt' | 'resolvedAt'>): DecisionRequest {
    const q: DecisionRequest = { ...input, id: `q_${nanoid(10)}`, status: 'open', response: null, createdAt: Date.now(), resolvedAt: null };
    requests.put(q);
    pubRequest(q);
    return q;
  }

  private async requestHuman(input: Omit<DecisionRequest, 'id' | 'status' | 'response' | 'createdAt' | 'resolvedAt'>, signal: AbortSignal): Promise<string> {
    const q = this.createRequest(input);
    const agent = input.agentId ? agents.get(input.agentId) : null;
    const approval = q.kind === 'approval';
    if (agent) {
      const doing = getLive(agent.id).detail;
      setLive(agent.id, { activity: approval ? 'waiting_approval' : 'waiting_user', requestId: q.id, detail: approval ? `needs approval: ${doing ?? q.tool}` : `asks: ${q.title.slice(0, 120)}` });
    }
    if (q.taskId) this.updateTask(q.taskId, (t) => (t.status = approval ? 'waiting_approval' : 'waiting_user'));
    log({
      runId: q.runId,
      taskId: q.taskId,
      agentId: q.agentId,
      type: approval ? 'approval_requested' : 'question_asked',
      level: 'important',
      summary: approval ? q.title : `${agent?.name} asks: ${q.title}`,
      data: { requestId: q.id },
    });
    const answer = await new Promise<string>((resolve, reject) => {
      const onAbort = () => {
        this.waiters.delete(q.id);
        const cur = requests.get(q.id);
        if (cur?.status === 'open') {
          cur.status = 'expired';
          cur.resolvedAt = Date.now();
          requests.put(cur);
          pubRequest(cur);
        }
        reject(new Cancelled());
      };
      this.waiters.set(q.id, (a) => {
        signal.removeEventListener('abort', onAbort);
        resolve(a);
      });
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    });
    if (q.taskId) this.updateTask(q.taskId, (t) => (t.status = 'running'));
    if (agent) setLive(agent.id, { activity: 'working', requestId: null, detail: approval ? 'approved, carrying on' : 'got an answer' });
    return answer;
  }

  private async consult(asker: Agent, target: Agent, question: string, signal: AbortSignal, runId: string, taskId?: string): Promise<string> {
    setLive(asker.id, { activity: 'consulting', withAgentId: target.id, detail: `asking ${target.name}` });
    log({ runId, taskId, agentId: asker.id, type: 'consult_start', level: 'important', summary: `${asker.name} asks ${target.name}: “${question.slice(0, 120)}”`, data: { targetId: target.id, question } });
    const provider = getProvider(target.providerId);
    if (!provider || !target.model) return `${target.name} has no model assigned and can't answer.`;
    const messages: NeutralMessage[] = [{ role: 'user', content: `${consultContext(target)}\n\n${asker.name} (${asker.title}) asks you: ${question}` }];
    try {
      const resp = await provider.chat({
        model: target.model,
        system: systemPrompt(target, 'consult', 1),
        messages,
        tools: [],
        effort: 'low',
        maxTokens: 2000,
        signal,
        hint: { phase: 'consult', agent: target, teammates: agents.all(), goal: runs.get(runId)?.goal },
      });
      charge(runId, taskId, target, resp);
      const answer = resp.text.trim() || '(no answer)';
      log({ runId, taskId, agentId: target.id, type: 'consult_answer', level: 'important', summary: `${target.name} → ${asker.name}: “${answer.slice(0, 140)}”`, data: { askerId: asker.id, answer: answer.slice(0, 2000), demo: !!resp.demo } });
      return answer;
    } catch (e) {
      if (signal.aborted) throw new Cancelled();
      const msg = e instanceof ProviderError ? e.message : redact(String(e));
      log({ runId, taskId, agentId: target.id, type: 'consult_failed', level: 'warn', summary: `${target.name} couldn't answer ${asker.name}: ${msg}` });
      return `${target.name} couldn't answer (${msg}).`;
    } finally {
      setLive(asker.id, { activity: 'working', withAgentId: null, detail: `back from ${target.name}` });
    }
  }

  private env(run: Run, agent: Agent, opts: Pick<LoopEnv, 'phase' | 'owner' | 'taskId' | 'brief' | 'maxSteps' | 'signal' | 'hint'>): LoopEnv {
    return {
      runId: run.id,
      agentId: agent.id,
      limits: { consults: run.limits.maxConsultsPerTask, questions: run.limits.maxQuestionsPerTask },
      gate: () => this.gate(run.id, agent.id, opts.signal),
      requestHuman: (req, signal) => this.requestHuman(req, signal),
      consult: (asker, target, q, signal) => this.consult(asker, target, q, signal, run.id, opts.taskId),
      takeNotes: () => {
        const n = this.notes.get(agent.id) ?? [];
        this.notes.delete(agent.id);
        if (n.length) log({ runId: run.id, taskId: opts.taskId, agentId: agent.id, type: 'redirect_delivered', level: 'info', summary: `${agent.name} received the Captain's message` });
        return n;
      },
      ...opts,
    };
  }


  startRun(goal: string, overrides: Partial<RunLimits>): Run {
    const active = runs.active();
    if (active) throw new Error('A mission is already under way. Finish or cancel it first.');
    const lead = this.lead();
    const limits = { ...DEFAULT_LIMITS, ...getSetting<Partial<RunLimits>>('limits', {}), ...overrides };
    const run: Run = {
      id: `r_${nanoid(10)}`,
      goal: goal.trim().slice(0, 4000),
      status: 'planning',
      limits,
      spentUsd: 0,
      tokensIn: 0,
      tokensOut: 0,
      demo: false,
      planRationale: null,
      summary: null,
      finalArtifactId: null,
      pauseReason: null,
      pausedFrom: null,
      error: null,
      replans: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      finishedAt: null,
    };
    runs.put(run);
    pubRun(run);
    for (const a of agents.all()) resetLive(a.id, a.enabled ? 'idle' : 'off_duty');
    log({ runId: run.id, type: 'run_created', level: 'important', summary: `New mission: “${run.goal.slice(0, 140)}”` });
    log({ runId: run.id, agentId: lead.id, type: 'planning', level: 'important', summary: `${lead.name} is drawing up a plan` });
    void this.runPlan(run.id);
    return run;
  }

  private async runPhase(runId: string, kind: 'plan' | 'synth' | 'replan', agent: Agent, build: (ac: AbortController) => LoopEnv, onFinal: (f: Final) => void) {
    const ac = new AbortController();
    this.phase = { runId, kind, ac };
    try {
      const res = await runLoop(build(ac));
      if (res.kind === 'final') onFinal(res.final);
      else this.phaseFailed(runId, kind, agent, res.reason);
    } catch (e) {
      if (e instanceof Cancelled) return;
      this.phaseFailed(runId, kind, agent, e instanceof Error ? e.message : String(e));
    } finally {
      if (this.phase?.ac === ac) this.phase = null;
      if (getLive(agent.id).activity !== 'failed') setLive(agent.id, { activity: 'idle', detail: null, taskId: null, requestId: null });
      this.tick();
    }
  }

  private phaseFailed(runId: string, kind: string, agent: Agent, reason: string) {
    const msg = redact(reason);
    setLive(agent.id, { activity: 'failed', detail: msg.slice(0, 80) });
    if (kind === 'replan') {
      log({ runId, agentId: agent.id, type: 'replan_failed', level: 'warn', summary: `${agent.name} couldn't revise the plan: ${msg}` });
      return;
    }
    this.update(runId, (r) => {
      r.status = 'failed';
      r.error = `${kind === 'plan' ? 'Planning' : 'Final report'} failed: ${msg}`;
      r.finishedAt = Date.now();
    });
    log({ runId, agentId: agent.id, type: 'run_failed', level: 'error', summary: `${kind === 'plan' ? 'Planning' : 'The final report'} failed: ${msg}` });
  }

  private async runPlan(runId: string) {
    const lead = this.lead();
    const run = runs.must(runId);
    setLive(lead.id, { activity: 'planning', runId, detail: 'reading the orders' });
    await this.runPhase(
      runId,
      'plan',
      lead,
      (ac) => this.env(run, lead, { phase: 'plan', owner: `plan:${runId}`, brief: () => planBrief(run, lead), maxSteps: 8, signal: ac.signal, hint: () => ({ goal: run.goal, run }) }),
      (f) => {
        if (f.tool !== 'submit_plan') throw wrongEnd(f, 'submit_plan');
        this.acceptPlan(runId, f.value);
      },
    );
  }

  private acceptPlan(runId: string, plan: { rationale: string; tasks: PlanTask[] }) {
    const run = runs.must(runId);
    // submit_plan already ran validatePlan: every assignee and dependency key resolves.
    const idByKey = new Map(plan.tasks.map((t) => [t.key, `t_${nanoid(10)}`]));
    const idOf = (key: string) => idByKey.get(key) ?? key;
    plan.tasks.forEach((p, i) => {
      const t: Task = {
        id: idOf(p.key),
        runId,
        key: p.key,
        title: p.title.slice(0, 140),
        description: p.description,
        acceptance: p.acceptance,
        assigneeId: findAgentByName(p.assignee)?.id ?? this.lead().id,
        dependsOn: p.depends_on.map(idOf),
        status: 'pending',
        resultSummary: null,
        notesForTeam: null,
        artifactIds: [],
        steps: 0,
        consults: 0,
        questions: 0,
        attempts: 0,
        error: null,
        spentUsd: 0,
        order: i,
        createdAt: Date.now(),
        startedAt: null,
        finishedAt: null,
      };
      taskDb.put(t);
      pubTask(t);
    });
    const review = run.limits.requirePlanApproval;
    this.update(runId, (r) => {
      r.planRationale = plan.rationale;
      r.status = review ? 'review' : 'running';
    });
    log({ runId, agentId: this.lead().id, type: 'plan_proposed', level: 'important', summary: `Plan ready: ${plan.tasks.length} tasks${review ? ', waiting for your go-ahead' : ''}` });
    if (review) {
      this.createRequest({ runId, taskId: null, agentId: this.lead().id, kind: 'plan', title: 'Review the mission plan', body: plan.rationale, options: ['Launch', 'Cancel mission'], tool: null, args: null, risk: null });
    }
  }

  launch(runId: string) {
    const run = runs.get(runId);
    if (!run || run.status !== 'review') throw new Error('This mission is not waiting for plan approval.');
    const planned = taskDb.byRun(runId);
    if (!planned.length) throw new Error('The plan has no tasks left.');
    for (const t of planned) {
      const a = agents.get(t.assigneeId);
      if (!a?.enabled) throw new Error(`“${t.title}” is assigned to someone who is off duty. Reassign it first.`);
      if (!a.providerId || !a.model) throw new Error(`${a.name} has no model assigned. Set one in their settings first.`);
    }
    for (const q of requests.byRun(runId)) {
      if (q.kind === 'plan' && q.status === 'open') {
        q.status = 'resolved';
        q.response = 'Launch';
        q.resolvedAt = Date.now();
        requests.put(q);
        pubRequest(q);
      }
    }
    this.update(runId, (r) => (r.status = 'running'));
    log({ runId, type: 'plan_approved', level: 'important', summary: 'Plan approved. Dive, dive, dive.' });
    this.tick();
  }

  /** The scheduler: starts every task whose dependencies are met, within the concurrency limit. */
  tick() {
    const run = runs.active();
    if (!run) return;
    const all = taskDb.byRun(run.id);
    this.refreshWaiting(run, all);
    if (run.status !== 'running') return;

    if (all.length && all.every((t) => TASK_OK.has(t.status) || t.status === 'cancelled')) {
      if (!this.phase) this.startSynth(run);
      return;
    }
    const busy = new Set(all.filter((t) => this.inflight.has(t.id)).map((t) => t.assigneeId));
    let slots = run.limits.concurrency - this.inflight.size;
    for (const t of all) {
      if (slots <= 0) break;
      if (t.status !== 'pending' || busy.has(t.assigneeId) || this.held.has(t.assigneeId)) continue;
      const deps = t.dependsOn.map((d) => all.find((x) => x.id === d));
      if (!deps.every((d) => d && TASK_OK.has(d.status))) continue;
      busy.add(t.assigneeId);
      slots--;
      void this.execTask(run, t);
    }
    this.refreshWaiting(run, taskDb.byRun(run.id));
  }

  /** Agents with nothing in flight: show them waiting on whoever owns their unmet dependencies. */
  private refreshWaiting(run: Run, all: Task[]) {
    if (run.status === 'planning' || run.status === 'synthesizing') return;
    for (const a of agents.all()) {
      if (all.some((t) => t.assigneeId === a.id && this.inflight.has(t.id))) continue;
      if (this.phase && this.phase.runId === run.id && a.id === this.lead().id) continue;
      const live = getLive(a.id);
      if (!a.enabled) {
        if (live.activity !== 'off_duty') resetLive(a.id, 'off_duty');
        continue;
      }
      const stuck = all.find((t) => t.assigneeId === a.id && (t.status === 'blocked' || t.status === 'failed'));
      if (stuck && !TERMINAL_RUN.has(run.status)) {
        setLive(a.id, { activity: stuck.status === 'failed' ? 'failed' : 'blocked', runId: run.id, taskId: stuck.id, blockedBy: [], withAgentId: null, detail: (stuck.error ?? 'stuck').slice(0, 80) });
        continue;
      }
      const next = all.find((t) => t.assigneeId === a.id && t.status === 'pending');
      if (next && !TERMINAL_RUN.has(run.status)) {
        const blockers = next.dependsOn
          .map((d) => all.find((x) => x.id === d))
          .filter((d): d is Task => !!d && !TASK_OK.has(d.status))
          .map((d) => d.assigneeId);
        const blockedBy = [...new Set(blockers)];
        const names = blockedBy.map((id) => agents.get(id)?.name).filter(Boolean);
        const held = this.held.has(a.id) && !blockedBy.length;
        let detail = 'waiting for a free slot';
        if (run.status === 'review') detail = 'waiting for launch';
        else if (blockedBy.length) detail = `waiting on ${names.join(' & ')}`;
        else if (held) detail = 'held by the Captain';
        setLive(a.id, {
          activity: run.status === 'paused' || held ? 'paused' : 'waiting_dep',
          runId: run.id,
          taskId: next.id,
          blockedBy,
          withAgentId: null,
          requestId: null,
          detail,
        });
      } else if (!['idle', 'chatting'].includes(live.activity) || live.taskId) {
        setLive(a.id, { activity: 'idle', taskId: null, blockedBy: [], withAgentId: null, requestId: null, detail: null, step: 0, maxSteps: 0 });
      }
    }
  }

  private async execTask(run: Run, task: Task) {
    const ac = new AbortController();
    this.inflight.set(task.id, ac);
    const agent = agents.must(task.assigneeId);
    this.updateTask(task.id, (t) => {
      t.status = 'running';
      t.startedAt ??= Date.now();
      t.error = null;
    });
    setLive(agent.id, { activity: 'working', runId: run.id, taskId: task.id, blockedBy: [], detail: 'reading the brief', step: 0, maxSteps: run.limits.maxStepsPerTask });
    const upstream = taskDb.byRun(run.id).filter((t) => task.dependsOn.includes(t.id));
    log({
      runId: run.id,
      taskId: task.id,
      agentId: agent.id,
      type: 'task_started',
      level: 'important',
      summary: `${agent.name} started “${task.title}”`,
      data: { from: [...new Set(upstream.map((u) => u.assigneeId))] },
    });
    try {
      const res = await runLoop(
        this.env(run, agent, {
          phase: 'task',
          owner: task.id,
          taskId: task.id,
          brief: () => taskBrief(runs.must(run.id), taskDb.must(task.id), agent),
          maxSteps: run.limits.maxStepsPerTask,
          signal: ac.signal,
          hint: () => ({
            run: runs.get(run.id),
            task: taskDb.get(task.id),
            goal: run.goal,
            depArtifacts: upstream.flatMap((u) => taskDb.must(u.id).artifactIds.map((id) => ({ id, name: artifacts.get(id)?.name ?? id, agentId: u.assigneeId }))),
          }),
        }),
      );
      if (res.kind === 'blocked') this.blockTask(task.id, res.reason);
      else if (res.final.tool === 'finish_task') this.finishTask(task.id, res.final.value);
      else throw wrongEnd(res.final, 'finish_task');
    } catch (e) {
      if (e instanceof Cancelled) {
        const cur = taskDb.get(task.id);
        if (cur && TASK_ACTIVE.has(cur.status)) this.updateTask(task.id, (t) => (t.status = 'pending'));
      } else {
        this.failTask(task.id, e instanceof Error ? e.message : String(e), !(e instanceof TaskFailure));
      }
    } finally {
      this.inflight.delete(task.id);
      const live = getLive(agent.id);
      if (live.taskId === task.id && live.activity !== 'failed') setLive(agent.id, { activity: 'idle', taskId: null, detail: null, withAgentId: null, requestId: null });
      this.tick();
    }
  }

  private finishTask(taskId: string, v: Handin) {
    const task = taskDb.must(taskId);
    const run = runs.must(task.runId);
    const agent = agents.must(task.assigneeId);
    let ids = v.artifactIds;
    if (v.autoSaveText) {
      const art = saveArtifact({ run, agent, taskId, demo: false }, { name: task.title, kind: 'markdown', content: v.autoSaveText, description: 'Saved from the agent’s reply', language: null });
      ids = [art.id];
    }
    if (v.status === 'blocked') {
      this.updateTask(taskId, (t) => {
        t.resultSummary = v.summary;
        t.notesForTeam = v.notes || null;
        t.artifactIds = ids;
      });
      return this.blockTask(taskId, v.summary);
    }
    const t = this.updateTask(taskId, (t) => {
      t.status = 'done';
      t.resultSummary = v.summary;
      t.notesForTeam = v.notes || null;
      t.artifactIds = ids;
      t.finishedAt = Date.now();
    });
    log({ runId: run.id, taskId, agentId: agent.id, type: 'task_done', level: 'important', summary: `${agent.name} finished “${t.title}”`, data: { artifactIds: ids } });

    const all = taskDb.byRun(run.id);
    for (const d of all.filter((x) => x.dependsOn.includes(taskId) && x.status === 'pending')) {
      const ready = d.dependsOn.every((id) => TASK_OK.has(all.find((x) => x.id === id)?.status ?? ''));
      const to = agents.get(d.assigneeId);
      log({
        runId: run.id,
        taskId: d.id,
        agentId: agent.id,
        type: 'handoff',
        level: 'important',
        summary: `${agent.name} → ${to?.name}: “${t.title}” delivered${ready ? '' : ` (${to?.name} still waiting on others)`}`,
        data: { fromId: agent.id, toId: d.assigneeId, artifactIds: ids, ready },
      });
    }
  }

  private blockTask(taskId: string, reason: string) {
    const task = this.updateTask(taskId, (t) => {
      t.status = 'blocked';
      t.error = redact(reason);
    });
    const agent = agents.must(task.assigneeId);
    const run = runs.must(task.runId);
    setLive(agent.id, { activity: 'blocked', taskId, detail: reason.slice(0, 80) });
    log({ runId: run.id, taskId, agentId: agent.id, type: 'task_blocked', level: 'warn', summary: `${agent.name} is stuck on “${task.title}”: ${reason.slice(0, 160)}` });
    if (run.replans < run.limits.maxReplans && run.status === 'running' && !this.phase) {
      this.update(run.id, (r) => r.replans++);
      void this.runReplan(run.id, taskId);
    } else {
      this.askAboutTask(task, 'blocked', reason);
    }
  }

  private failTask(taskId: string, message: string, unexpected: boolean) {
    const msg = redact(message);
    const task = this.updateTask(taskId, (t) => {
      t.status = 'failed';
      t.error = msg;
      t.attempts++;
    });
    const agent = agents.must(task.assigneeId);
    setLive(agent.id, { activity: 'failed', taskId, detail: msg.slice(0, 80) });
    log({ runId: task.runId, taskId, agentId: agent.id, type: 'task_failed', level: 'error', summary: `${agent.name} failed “${task.title}”: ${msg}`, data: { unexpected } });
    this.askAboutTask(task, 'failed', msg);
  }

  private askAboutTask(task: Task, what: 'blocked' | 'failed', reason: string) {
    const agent = agents.get(task.assigneeId);
    if (requests.byRun(task.runId).some((q) => q.taskId === task.id && q.kind === 'blocked' && q.status === 'open')) return;
    this.createRequest({
      runId: task.runId,
      taskId: task.id,
      agentId: task.assigneeId,
      kind: 'blocked',
      title: `${agent?.name} ${what === 'failed' ? 'hit an error' : 'is stuck'} on “${task.title}”`,
      body: reason,
      options: ['Retry', 'Skip this task', 'Cancel mission'],
      tool: null,
      args: null,
      risk: null,
    });
  }

  private async runReplan(runId: string, blockedId: string) {
    const lead = this.lead();
    const run = runs.must(runId);
    const blocked = taskDb.must(blockedId);
    log({ runId, agentId: lead.id, type: 'replanning', level: 'important', summary: `${lead.name} is reworking the plan around “${blocked.title}”` });
    setLive(lead.id, { activity: 'planning', runId, detail: 'reworking the plan' });
    const n = run.replans;
    await this.runPhase(
      runId,
      'replan',
      lead,
      (ac) =>
        this.env(run, lead, {
          phase: 'replan',
          owner: `replan:${runId}:${n}`,
          brief: () => replanBrief(runs.must(runId), taskDb.must(blockedId)),
          maxSteps: 6,
          signal: ac.signal,
          hint: () => ({ run: runs.get(runId), task: taskDb.get(blockedId), goal: run.goal }),
        }),
      (f) => {
        if (f.tool !== 'revise_plan') throw wrongEnd(f, 'revise_plan');
        this.applyRevision(runId, f.value);
      },
    );
    const after = taskDb.get(blockedId);
    if (after?.status === 'blocked') this.askAboutTask(after, 'blocked', after.error ?? 'Blocked');
  }

  private applyRevision(runId: string, rev: Revision) {
    const all = taskDb.byRun(runId);
    const byKey = new Map(all.map((t) => [t.key, t]));
    const added: Task[] = [];
    for (const a of rev.add.slice(0, 3)) {
      const owner = findAgentByName(a.assignee);
      if (!owner || byKey.has(a.key)) continue;
      added.push({
        id: `t_${nanoid(10)}`, runId, key: a.key, title: a.title.slice(0, 140), description: a.description, acceptance: a.acceptance,
        assigneeId: owner.id, dependsOn: [],
        status: 'pending', resultSummary: null, notesForTeam: null, artifactIds: [], steps: 0, consults: 0, questions: 0, attempts: 0,
        error: null, spentUsd: 0, order: all.length + added.length, createdAt: Date.now(), startedAt: null, finishedAt: null,
      });
    }
    const idOfKey = new Map([...all, ...added].map((t) => [t.key, t.id]));
    for (const t of added) {
      const spec = rev.add.find((a) => a.key === t.key);
      t.dependsOn = (spec?.depends_on ?? []).flatMap((k) => idOfKey.get(k) ?? []);
      taskDb.put(t);
      pubTask(t);
    }
    for (const r of rev.retry) {
      const t = byKey.get(r.key);
      if (!t || !['blocked', 'failed'].includes(t.status)) continue;
      const who = r.assignee ? findAgentByName(r.assignee) : undefined;
      if (who && who.id !== t.assigneeId) transcripts.clear(t.id);
      else transcripts.append(t.id, { role: 'user', content: `[Message from ${this.lead().name}, mission lead] Please try again. ${r.note}` } satisfies NeutralMessage);
      this.updateTask(t.id, (x) => {
        x.status = 'pending';
        x.attempts++;
        x.assigneeId = who?.id ?? x.assigneeId;
        // Tasks added in this revision are prerequisites for the retry.
        x.dependsOn = [...new Set([...x.dependsOn, ...added.map((n) => n.id)])];
      });
    }
    for (const k of rev.skip) {
      const t = byKey.get(k);
      if (t && !TASK_OK.has(t.status) && !this.inflight.has(t.id)) this.updateTask(t.id, (x) => (x.status = 'skipped'));
    }
    log({ runId, agentId: this.lead().id, type: 'plan_revised', level: 'important', summary: `Plan revised: ${rev.rationale.slice(0, 160)}` });
  }

  private startSynth(run: Run) {
    const all = taskDb.byRun(run.id);
    const done = all.filter((t) => t.status === 'done');
    // One task? Its output is the deliverable; skip the extra model calls.
    if (done.length === 1 && all.length === 1 && done[0].artifactIds.length) {
      return this.complete(run.id, done[0].resultSummary ?? 'Done.', done[0].artifactIds[done[0].artifactIds.length - 1]);
    }
    const lead = this.lead();
    this.update(run.id, (r) => (r.status = 'synthesizing'));
    log({ runId: run.id, agentId: lead.id, type: 'synthesizing', level: 'important', summary: `All tasks done. ${lead.name} is writing the final report.` });
    setLive(lead.id, { activity: 'working', runId: run.id, detail: 'writing the final report' });
    void this.runPhase(
      run.id,
      'synth',
      lead,
      (ac) => this.env(run, lead, { phase: 'synth', owner: `synth:${run.id}`, brief: () => synthBrief(runs.must(run.id)), maxSteps: 10, signal: ac.signal, hint: () => ({ run: runs.get(run.id), goal: run.goal, depArtifacts: artifacts.byRun(run.id).map((a) => ({ id: a.id, name: a.name, agentId: a.agentId })) }) }),
      (f) => {
        if (f.tool !== 'finish_task') throw wrongEnd(f, 'finish_task');
        this.complete(run.id, f.value.summary, f.value.primary);
      },
    );
  }

  private complete(runId: string, summary: string, finalId: string | null) {
    const run = this.update(runId, (r) => {
      r.status = 'completed';
      r.summary = summary;
      r.finalArtifactId = finalId;
      r.finishedAt = Date.now();
      r.pauseReason = null;
    });
    saveMemory({
      scope: 'shared',
      agentId: null,
      runId,
      content: `Mission “${run.goal.slice(0, 200)}” completed. ${summary.slice(0, 600)}`,
      tags: 'mission-log',
      source: 'mission log',
      pinned: false,
      demo: run.demo,
    });
    log({ runId, type: 'run_completed', level: 'important', summary: `Mission complete: ${summary.slice(0, 200)}`, data: { finalArtifactId: finalId } });
    for (const a of agents.all()) resetLive(a.id, a.enabled ? 'idle' : 'off_duty');
  }


  pause(runId: string, reason = 'Paused by the Captain') {
    const r = runs.get(runId);
    if (!r || TERMINAL_RUN.has(r.status) || r.status === 'paused') return;
    this.update(runId, (x) => {
      x.pausedFrom = x.status;
      x.status = 'paused';
      x.pauseReason = reason;
    });
    const busy = this.inflight.size;
    log({ runId, type: 'run_paused', level: 'important', summary: busy ? `All stop. ${busy === 1 ? 'One agent finishes its' : `${busy} agents finish their`} current step, then waits.` : 'All stop.' });
    this.tick();
  }

  resume(runId: string) {
    const r = runs.get(runId);
    if (!r || r.status !== 'paused') return;
    if (this.overBudget(r)) throw new Error('The budget is used up. Raise it first.');
    const to = r.pausedFrom && r.pausedFrom !== 'paused' ? r.pausedFrom : 'running';
    this.update(runId, (x) => {
      x.status = to;
      x.pauseReason = null;
      x.pausedFrom = null;
    });
    log({ runId, type: 'run_resumed', level: 'important', summary: 'Ahead. The crew is back at work.' });
    this.notify();
    // After a restart the phase loops aren't running; start them again from their transcripts.
    if (!this.phase) {
      if (to === 'planning') void this.runPlan(runId);
      if (to === 'synthesizing') this.startSynth(runs.must(runId));
    }
    this.tick();
  }

  cancel(runId: string) {
    const r = runs.get(runId);
    if (!r || TERMINAL_RUN.has(r.status)) return;
    this.update(runId, (x) => {
      x.status = 'cancelled';
      x.finishedAt = Date.now();
    });
    for (const ac of this.inflight.values()) ac.abort();
    if (this.phase?.runId === runId) this.phase.ac.abort();
    for (const t of taskDb.byRun(runId)) if (!TASK_OK.has(t.status)) this.updateTask(t.id, (x) => (x.status = 'cancelled'));
    for (const q of requests.byRun(runId)) {
      if (q.status === 'open') {
        q.status = 'expired';
        q.resolvedAt = Date.now();
        requests.put(q);
        pubRequest(q);
      }
    }
    this.notify();
    log({ runId, type: 'run_cancelled', level: 'important', summary: 'Mission cancelled. Surfacing.' });
    for (const a of agents.all()) resetLive(a.id, a.enabled ? 'idle' : 'off_duty');
  }

  setLimits(runId: string, patch: Partial<RunLimits>) {
    const r = this.update(runId, (x) => (x.limits = { ...x.limits, ...patch }));
    log({ runId, type: 'limits_changed', level: 'info', summary: `Limits updated: budget $${r.limits.budgetUsd.toFixed(2)}, ${r.limits.concurrency} at a time` });
    this.tick();
  }

  hold(agentId: string, on: boolean) {
    if (on) this.held.add(agentId);
    else this.held.delete(agentId);
    const a = agents.get(agentId);
    log({ runId: runs.active()?.id, agentId, type: on ? 'agent_held' : 'agent_released', level: 'important', summary: on ? `${a?.name} is on hold` : `${a?.name} is back on duty` });
    this.notify();
    this.tick();
  }

  heldAgents() {
    return [...this.held];
  }

  stopTask(taskId: string) {
    const ac = this.inflight.get(taskId);
    const t = taskDb.get(taskId);
    if (!t) return;
    if (ac) ac.abort();
    this.inflight.delete(taskId);
    this.updateTask(taskId, (x) => {
      x.status = 'blocked';
      x.error = 'Stopped by the Captain.';
    });
    setLive(t.assigneeId, { activity: 'idle', taskId: null, detail: null });
    log({ runId: t.runId, taskId, agentId: t.assigneeId, type: 'task_stopped', level: 'important', summary: `You stopped “${t.title}”` });
    this.askAboutTask(taskDb.must(taskId), 'blocked', 'Stopped by the Captain.');
  }

  retryTask(taskId: string, note?: string) {
    const t = taskDb.get(taskId);
    if (!t || !['blocked', 'failed', 'skipped', 'cancelled'].includes(t.status)) throw new Error('Only stopped, failed or skipped tasks can be retried.');
    if (note?.trim()) transcripts.append(taskId, { role: 'user', content: `[Message from the Captain] ${note.trim()}` } satisfies NeutralMessage);
    this.updateTask(taskId, (x) => {
      x.status = 'pending';
      x.error = null;
    });
    this.resolveTaskRequests(taskId, 'Retry');
    setLive(t.assigneeId, { activity: 'idle', detail: null });
    log({ runId: t.runId, taskId, agentId: t.assigneeId, type: 'task_retry', level: 'important', summary: `Retrying “${t.title}”` });
    this.tick();
  }

  skipTask(taskId: string) {
    const t = taskDb.get(taskId);
    if (!t || TASK_OK.has(t.status)) return;
    this.inflight.get(taskId)?.abort();
    this.inflight.delete(taskId);
    this.updateTask(taskId, (x) => (x.status = 'skipped'));
    this.resolveTaskRequests(taskId, 'Skip this task');
    setLive(t.assigneeId, { activity: 'idle', taskId: null, detail: null });
    log({ runId: t.runId, taskId, agentId: t.assigneeId, type: 'task_skipped', level: 'important', summary: `Skipped “${t.title}”` });
    this.tick();
  }

  private resolveTaskRequests(taskId: string, response: string) {
    for (const q of requests.open()) {
      if (q.taskId === taskId && q.kind === 'blocked') {
        q.status = 'resolved';
        q.response = response;
        q.resolvedAt = Date.now();
        requests.put(q);
        pubRequest(q);
      }
    }
  }

  editTask(taskId: string, patch: Partial<Pick<Task, 'title' | 'description' | 'acceptance' | 'assigneeId' | 'dependsOn'>>) {
    const t = taskDb.get(taskId);
    const run = t && runs.get(t.runId);
    if (!t || !run) throw new Error('No such task');
    if (!(run.status === 'review' || t.status === 'pending' || t.status === 'blocked' || t.status === 'failed')) throw new Error('Only tasks that have not started (or are stuck) can be edited.');
    if (patch.assigneeId && !agents.get(patch.assigneeId)?.enabled) throw new Error('That crew member is off duty or missing.');
    if (patch.dependsOn) {
      const all = taskDb.byRun(t.runId);
      const deps = new Map(all.map((x) => [x.id, x.id === taskId ? patch.dependsOn! : x.dependsOn]));
      if (patch.dependsOn.some((d) => !deps.has(d))) throw new Error('Unknown dependency');
      const reaches = (from: string, seen = new Set<string>()): boolean =>
        from === taskId || (!seen.has(from) && (seen.add(from), (deps.get(from) ?? []).some((d) => reaches(d, seen))));
      if (patch.dependsOn.some((d) => reaches(d))) throw new Error('That would make tasks wait on each other in a circle.');
    }
    const reassigned = patch.assigneeId && patch.assigneeId !== t.assigneeId;
    const updated = this.updateTask(taskId, (x) => Object.assign(x, patch));
    if (reassigned) transcripts.clear(taskId);
    log({ runId: t.runId, taskId, type: 'task_edited', level: 'info', summary: `You edited “${updated.title}”` });
    this.tick();
    return updated;
  }

  removeTask(taskId: string) {
    const t = taskDb.get(taskId);
    const run = t && runs.get(t.runId);
    if (!t || !run || run.status !== 'review') throw new Error('Tasks can only be removed while reviewing the plan.');
    taskDb.remove(taskId);
    broadcast({ kind: 'remove', entity: 'task', id: taskId });
    for (const o of taskDb.byRun(t.runId)) {
      if (o.dependsOn.includes(taskId)) this.updateTask(o.id, (x) => (x.dependsOn = x.dependsOn.filter((d) => d !== taskId)));
    }
  }

  resolve(requestId: string, response: string) {
    const q = requests.get(requestId);
    if (!q || q.status !== 'open') throw new Error('This request is no longer open.');
    const answer = response.trim().slice(0, 4000);
    if (!answer) throw new Error('Empty answer');
    q.status = 'resolved';
    q.response = answer;
    q.resolvedAt = Date.now();
    requests.put(q);
    pubRequest(q);
    const agent = q.agentId ? agents.get(q.agentId) : null;
    log({
      runId: q.runId,
      taskId: q.taskId,
      agentId: q.agentId,
      type: q.kind === 'approval' ? (/^approve/i.test(answer) ? 'approval_granted' : 'approval_denied') : 'decision',
      level: 'important',
      summary:
        q.kind === 'approval'
          ? `${/^approve/i.test(answer) ? 'Approved' : 'Denied'}: ${q.title.replace(/^.*? wants to /, `${agent?.name} may `)}`
          : `You answered${agent ? ` ${agent.name}` : ''}: “${answer.slice(0, 120)}”`,
    });

    const waiter = this.waiters.get(requestId);
    if (waiter) {
      this.waiters.delete(requestId);
      waiter(answer);
      return;
    }
    const run = q.runId ? runs.get(q.runId) : null;
    if (!run) return;
    if (q.kind === 'plan') {
      if (/^launch/i.test(answer)) this.launch(run.id);
      else if (/^cancel/i.test(answer)) this.cancel(run.id);
    } else if (q.kind === 'budget') {
      if (/^add/i.test(answer)) {
        this.setLimits(run.id, { budgetUsd: +(run.limits.budgetUsd * 1.5).toFixed(2), maxTokens: Math.round(run.limits.maxTokens * 1.5) });
        this.resume(run.id);
      } else if (/^wrap/i.test(answer)) {
        this.wrapUp(run.id);
      } else if (/^cancel/i.test(answer)) this.cancel(run.id);
    } else if (q.kind === 'blocked' && q.taskId) {
      if (/^retry/i.test(answer)) this.retryTask(q.taskId);
      else if (/^skip/i.test(answer)) this.skipTask(q.taskId);
      else if (/^cancel/i.test(answer)) this.cancel(run.id);
      else this.retryTask(q.taskId, answer);
    }
  }

  /** Stop remaining work and have the lead write the report from what exists (a small, stated overage). */
  wrapUp(runId: string) {
    const run = runs.must(runId);
    for (const [id, ac] of this.inflight) {
      ac.abort();
      this.inflight.delete(id);
    }
    for (const t of taskDb.byRun(runId)) if (!TASK_OK.has(t.status)) this.updateTask(t.id, (x) => (x.status = 'skipped'));
    const extra = Math.max(0.25, run.limits.budgetUsd * 0.15);
    this.update(runId, (r) => {
      r.limits = { ...r.limits, budgetUsd: +(r.spentUsd + extra).toFixed(2), maxTokens: r.tokensIn + r.tokensOut + 400_000 };
      r.status = 'running';
      r.pauseReason = null;
      r.pausedFrom = null;
    });
    log({ runId, type: 'wrap_up', level: 'important', summary: `Wrapping up with what we have. The lead gets up to $${extra.toFixed(2)} more for the final report.` });
    this.notify();
    this.tick();
  }


  async chat(agentId: string, text: string, mode: 'ask' | 'redirect'): Promise<void> {
    const agent = agents.get(agentId);
    if (!agent) throw new Error('No such crew member');
    const run = runs.active();
    const msg = (role: ChatMessage['role'], content: string, extra: Partial<ChatMessage> = {}): ChatMessage => {
      const m: ChatMessage = { id: `c_${nanoid(10)}`, agentId, role, mode, content, runId: run?.id ?? null, demo: false, error: false, ts: Date.now(), ...extra };
      chats.put(m);
      broadcast({ kind: 'upsert', entity: 'chat', data: m });
      return m;
    };
    msg('user', text);

    if (mode === 'redirect') {
      const working = run && taskDb.byRun(run.id).some((t) => t.assigneeId === agentId && TASK_ACTIVE.has(t.status));
      if (!run || !working) {
        msg('system', `${agent.name} isn't working on anything right now, so there's nothing to redirect. Use Ask to talk, or edit their pending task on the plan board.`, { error: true });
        return;
      }
      this.notes.set(agentId, [...(this.notes.get(agentId) ?? []), text]);
      log({ runId: run.id, agentId, type: 'redirect', level: 'important', summary: `You → ${agent.name}: “${text.slice(0, 120)}”` });
      msg('system', `Delivered. ${agent.name} will see it after their current step.`);
      return;
    }

    const provider = getProvider(agent.providerId);
    if (!provider || !agent.model) {
      msg('agent', `${agent.name} has no model assigned. Choose a provider in their settings.`, { error: true });
      return;
    }
    const prevLive = getLive(agentId);
    const idle = prevLive.activity === 'idle' || prevLive.activity === 'off_duty';
    if (idle) setLive(agentId, { activity: 'chatting', detail: 'talking to the Captain' });
    const history = chats
      .byAgent(agentId, 12)
      .filter((c) => c.mode === 'ask' && c.role !== 'system' && !c.error)
      .slice(0, -1);
    const messages: NeutralMessage[] = [
      ...history.map((c): NeutralMessage => (c.role === 'user' ? { role: 'user', content: c.content } : { role: 'assistant', text: c.content, toolCalls: [] })),
      { role: 'user', content: `${consultContext(agent)}${prevLive.detail ? `\nRight now you are: ${prevLive.detail}.` : ''}\n\nThe Captain says: ${text}` },
    ];
    // Providers need alternating turns; merge any accidental repeats.
    const merged: NeutralMessage[] = [];
    for (const m of messages) {
      const last = merged[merged.length - 1];
      if (last && last.role === m.role) {
        if (m.role === 'user' && last.role === 'user') last.content += `\n\n${m.content}`;
        else if (m.role === 'assistant' && last.role === 'assistant') last.text += `\n\n${m.text}`;
      } else merged.push({ ...m });
    }
    if (merged[0]?.role === 'assistant') merged.shift();
    streamReset(agentId, 'chat');
    try {
      const resp = await provider.chat({
        model: agent.model,
        system: systemPrompt(agent, 'chat', 1),
        messages: merged,
        tools: [],
        effort: 'low',
        maxTokens: 3000,
        signal: AbortSignal.timeout(180_000),
        onText: (d) => streamDelta(agentId, 'chat', 'text', d),
        hint: { phase: 'chat', agent, teammates: agents.all(), question: text, goal: run?.goal },
      });
      if (run) charge(run.id, undefined, agent, resp);
      msg('agent', resp.text.trim() || '(no reply)', { demo: !!resp.demo });
    } catch (e) {
      msg('agent', e instanceof ProviderError ? e.message : redact(e instanceof Error ? e.message : String(e)), { error: true });
    } finally {
      if (idle) setLive(agentId, { activity: 'idle', detail: null });
    }
  }
}

export const orchestrator = new Orchestrator();
