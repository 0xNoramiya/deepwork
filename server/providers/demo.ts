import type { Agent } from '../../shared/types.ts';
import type { ChatRequest, ChatResponse, ModelProvider, NeutralMessage, ToolCall, ToolResult } from './types.ts';

/**
 * Demo provider: stands in for a language model when no credentials are set up.
 *
 * Everything around it is real: the scheduler, dependencies, tool execution,
 * approvals, questions, persistence and artifacts on disk. Only the "thinking" is
 * scripted. It picks plausible tool calls from the agent's role and what has
 * happened so far, and every word it produces is marked as simulated.
 */
export const DEMO_BANNER =
  '> **Simulated output (demo mode).** No language model wrote this. Deepwork filled in a template so you can see how the crew coordinates. Connect a model provider in Settings for real work.\n\n';

type Kind = 'research' | 'build' | 'write' | 'review' | 'lead';

function kindOf(a: Agent): Kind {
  const s = `${a.sprite} ${a.title} ${a.role}`.toLowerCase();
  if (a.isLead) return 'lead';
  if (/research|sonar|scout|analy/.test(s)) return 'research';
  if (/review|inspect|qa|critic|editor/.test(s)) return 'review';
  if (/writ|author|copy|doc/.test(s)) return 'write';
  if (/engineer|build|develop|code|design/.test(s)) return 'build';
  return 'write';
}

let counter = 0;
const callId = () => `demo_${Date.now().toString(36)}_${(counter++).toString(36)}`;

// DEEPWORK_DEMO_SPEED=0 makes the demo instant (used by tests); 1 is watchable pacing.
const SPEED = Number(process.env.DEEPWORK_DEMO_SPEED ?? 1);

function sleep(ms: number, signal: AbortSignal) {
  ms *= SPEED;
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new Error('Request cancelled'));
    const onAbort = () => {
      clearTimeout(t);
      reject(new Error('Request cancelled'));
    };
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function short(goal: string, n = 60) {
  const g = goal.replace(/\s+/g, ' ').trim();
  return g.length > n ? `${g.slice(0, n - 1)}…` : g;
}

function lastResults(messages: NeutralMessage[]): ToolResult[] {
  const last = messages[messages.length - 1];
  return last?.role === 'user' ? (last.toolResults ?? []) : [];
}

function allResults(messages: NeutralMessage[]): ToolResult[] {
  return messages.flatMap((m) => (m.role === 'user' ? (m.toolResults ?? []) : []));
}

function turns(messages: NeutralMessage[]) {
  return messages.filter((m) => m.role === 'assistant').length;
}

export class DemoProvider implements ModelProvider {
  id = 'demo';
  kind = 'demo' as const;
  label = 'Demo (simulated, no model)';

  async listModels() {
    return ['simulated'];
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const { narration, calls, text } = this.decide(req);
    await sleep(500 + Math.random() * 900, req.signal);
    const line = `[simulated] ${narration}`;
    for (let i = 0; i < line.length; i += 4) {
      req.onText?.(line.slice(i, i + 4));
      if (SPEED) await sleep(22, req.signal);
    }
    await sleep(300 + Math.random() * 700, req.signal);
    const fullText = text ?? line;
    return {
      text: fullText,
      toolCalls: calls,
      usage: { input: 0, output: 0 },
      stopReason: calls.length ? 'tool_use' : 'end',
      model: 'simulated',
      demo: true,
    };
  }

  private decide(req: ChatRequest): { narration: string; calls: ToolCall[]; text?: string } {
    const h = req.hint;
    const n = turns(req.messages);
    const call = (name: string, args: Record<string, unknown>): ToolCall => ({ id: callId(), name, args });
    const goal = h.goal ?? h.run?.goal ?? '';

    if (h.phase === 'consult' || h.phase === 'chat') {
      const reply =
        h.phase === 'consult'
          ? `[simulated reply from ${h.agent.name}] Good question. From where I sit as ${h.agent.title}, I'd focus on what the Captain asked for: "${short(goal, 80)}". (Demo mode: this answer is canned, not generated.)`
          : `[simulated reply] This is ${h.agent.name}, ${h.agent.title}. In demo mode I can't actually think about "${short(h.question ?? '', 80)}". Connect a model provider in Settings and I'll answer for real.`;
      return { narration: 'replying', calls: [], text: reply };
    }

    if (h.phase === 'plan') {
      const prev = lastResults(req.messages);
      if (n === 0) return { narration: 'Checking the archive for anything relevant from earlier missions…', calls: [call('recall', { query: goal })] };
      if (prev.some((r) => r.name === 'submit_plan' && r.isError) && n > 3) {
        return { narration: 'The plan keeps getting rejected; asking the Captain.', calls: [call('ask_user', { question: 'I could not produce a valid plan. How should we proceed?', options: ['Cancel mission'] })] };
      }
      return { narration: 'Splitting the mission into parallel work streams.', calls: [call('submit_plan', this.plan(h.teammates, goal))] };
    }

    if (h.phase === 'replan') {
      return {
        narration: 'Giving the blocked task one more try with clearer instructions.',
        calls: [call('revise_plan', { rationale: 'Retry once with a narrower scope.', retry: [{ key: h.task?.key ?? '', note: 'Narrow the scope and deliver whatever is solid.' }] })],
      };
    }

    if (h.phase === 'synth') {
      if (n === 0) return { narration: 'Gathering everything the crew filed.', calls: [call('list_artifacts', {})] };
      if (n === 1) {
        return {
          narration: 'Writing the final report for the Captain.',
          calls: [call('write_artifact', { name: 'Final report', kind: 'markdown', description: 'Mission deliverable', content: this.finalReport(goal, h) })],
        };
      }
      return { narration: 'Handing the report to the Captain.', calls: [call('finish_task', { summary: `Simulated mission complete for "${short(goal)}". See the final report.`, status: 'done', artifacts: ['Final report'] })] };
    }

    const kind = kindOf(h.agent);
    const task = h.task!;
    const results = allResults(req.messages);
    const deps = h.depArtifacts ?? [];
    const title = task.title;
    const researcher = h.teammates.find((t) => kindOf(t) === 'research' && t.id !== h.agent.id);

    const steps: Record<Kind, (() => { narration: string; calls: ToolCall[] })[]> = {
      research: [
        () => ({ narration: `Checking the archive before I start on "${title}".`, calls: [call('recall', { query: `${goal} ${title}` })] }),
        () => ({
          narration: 'I want one outside source. That needs the Captain’s approval at the radio room.',
          calls: [call('web_fetch', { url: `https://en.wikipedia.org/wiki/Special:Search?search=${encodeURIComponent(short(goal, 50))}`, reason: 'Get a neutral overview of the topic.' })],
        }),
        () => ({ narration: 'Logging a finding in shared memory for the rest of the crew.', calls: [call('remember', { content: `[demo] Research note for "${short(goal)}": start from the basics and cite sources.`, tags: 'demo research' })] }),
        () => ({ narration: 'Filing my research notes.', calls: [call('write_artifact', { name: `Research notes: ${short(title, 40)}`, kind: 'markdown', description: 'Findings and sources', content: this.researchDoc(goal, title, results) })] }),
        () => ({ narration: 'Done. Sending my notes down the tube.', calls: [call('finish_task', { summary: 'Simulated research notes filed.', status: 'done', artifacts: [`Research notes: ${short(title, 40)}`], notes_for_team: 'Notes are skeletal (demo mode).' })] }),
      ],
      build: [
        () => ({ narration: `Reading the brief for "${title}".`, calls: [call('recall', { query: title })] }),
        () => ({ narration: 'Sketching a structure and a checklist.', calls: [call('write_artifact', { name: `Blueprint: ${short(title, 40)}`, kind: 'markdown', description: 'Structure and plan', content: this.blueprint(goal, title) })] }),
        () => ({ narration: 'Blueprint is on the shelf.', calls: [call('finish_task', { summary: 'Simulated blueprint filed.', status: 'done', artifacts: [`Blueprint: ${short(title, 40)}`] })] }),
      ],
      write: [
        () => ({ narration: 'Seeing what the others have filed so far.', calls: [call('list_artifacts', {})] }),
        () =>
          deps.length
            ? { narration: `Reading "${deps[0].name}".`, calls: [call('read_artifact', { name: deps[0].name })] }
            : { narration: 'Nothing upstream to read; checking memory instead.', calls: [call('recall', { query: goal })] },
        () =>
          researcher
            ? { narration: `Walking over to ask ${researcher.name} a question.`, calls: [call('ask_teammate', { teammate: researcher.name, question: 'What is the single most important thing the draft should get right?' })] }
            : { narration: 'Thinking about structure.', calls: [call('recall', { query: title })] },
        () => ({ narration: 'Typing up the draft.', calls: [call('write_artifact', { name: `Draft: ${short(title, 40)}`, kind: 'markdown', description: 'Working draft', content: this.draft(goal, title, results) })] }),
        () => ({ narration: 'Draft filed.', calls: [call('finish_task', { summary: 'Simulated draft filed.', status: 'done', artifacts: [`Draft: ${short(title, 40)}`] })] }),
      ],
      review: [
        () => ({ narration: 'Pulling the latest work from the archive.', calls: [call('list_artifacts', {})] }),
        () => ({ narration: 'I need a call from the Captain before I sign off.', calls: [call('ask_user', { question: 'For the final version, which tone should we aim for?', options: ['Concise and formal', 'Friendly and plain-spoken'], why: 'The draft could go either way.' })] }),
        () => ({ narration: 'Writing up review notes.', calls: [call('write_artifact', { name: `Review: ${short(title, 40)}`, kind: 'markdown', description: 'Checks against acceptance criteria', content: this.review(goal, task.acceptance, results) })] }),
        () => ({ narration: 'Review complete.', calls: [call('finish_task', { summary: 'Simulated review filed.', status: 'done', artifacts: [`Review: ${short(title, 40)}`] })] }),
      ],
      lead: [
        () => ({ narration: 'Checking the archive.', calls: [call('recall', { query: title })] }),
        () => ({ narration: 'Writing a short brief.', calls: [call('write_artifact', { name: `Brief: ${short(title, 40)}`, kind: 'markdown', description: 'Brief', content: `${DEMO_BANNER}# ${title}\n\nA placeholder brief for "${goal}".\n` })] }),
        () => ({ narration: 'Filed.', calls: [call('finish_task', { summary: 'Simulated brief filed.', status: 'done', artifacts: [`Brief: ${short(title, 40)}`] })] }),
      ],
    };
    const list = steps[kind];
    const pick = list[Math.min(n, list.length - 1)];
    return pick();
  }

  private plan(team: Agent[], goal: string) {
    const by = (k: Kind) => team.find((a) => kindOf(a) === k && a.enabled);
    const lead = team.find((a) => a.isLead);
    const who = (k: Kind) => (by(k) ?? lead ?? team[0]).name;
    const g = short(goal, 48);
    return {
      rationale: `[simulated] Research and structure can run in parallel; the draft needs both; review closes it out.`,
      tasks: [
        { key: 'research', title: `Survey the ground: ${g}`, description: `Collect background, prior art and key facts for: ${goal}`, assignee: who('research'), depends_on: [], acceptance: 'Notes with sources the writer can rely on.' },
        { key: 'blueprint', title: 'Lay out the structure', description: `Propose an outline or technical structure for: ${goal}`, assignee: who('build'), depends_on: [], acceptance: 'A clear outline with sections or components.' },
        { key: 'draft', title: 'Write the first full draft', description: 'Combine the research and the blueprint into a complete draft.', assignee: who('write'), depends_on: ['research', 'blueprint'], acceptance: 'A complete draft that addresses the goal.' },
        { key: 'review', title: 'Review and tighten', description: 'Check the draft against the goal and flag gaps.', assignee: who('review'), depends_on: ['draft'], acceptance: 'A list of concrete fixes, or a sign-off.' },
      ],
    };
  }

  private researchDoc(goal: string, title: string, results: ToolResult[]) {
    const fetched = results.find((r) => r.name === 'web_fetch');
    const src = !fetched
      ? '_No outside source was consulted._'
      : fetched.isError
        ? `_The web request did not go through: ${fetched.content.slice(0, 160)}_`
        : `The Captain approved one web request. The page that came back starts with:\n\n> ${fetched.content.replace(/\s+/g, ' ').slice(0, 280)}…`;
    return `${DEMO_BANNER}# Research notes: ${title}\n\n**Mission:** ${goal}\n\n## Source\n\n${src}\n\n## Findings (placeholder)\n\n- A real researcher agent would summarise the key facts here.\n- It would cite each source and flag open questions.\n\n## Open questions\n\n- What does "done" look like for the Captain?\n`;
  }

  private blueprint(goal: string, title: string) {
    return `${DEMO_BANNER}# Blueprint: ${title}\n\n**Mission:** ${goal}\n\n## Proposed structure\n\n1. Context and goal\n2. Key findings\n3. Recommendation\n4. Next steps\n\n## Checklist\n\n- [ ] Every section answers the mission\n- [ ] Sources cited\n- [ ] Clear next action\n`;
  }

  private draft(goal: string, title: string, results: ToolResult[]) {
    const answer = results.find((r) => r.name === 'ask_teammate');
    return `${DEMO_BANNER}# ${title}\n\n**Mission:** ${goal}\n\n## Context\n\nPlaceholder prose. A real writer agent would build this from the research notes and the blueprint.\n\n## What a teammate said\n\n${answer ? `> ${answer.content.slice(0, 400)}` : '_No consultation happened._'}\n\n## Recommendation\n\n_To be written by a real model._\n`;
  }

  private review(goal: string, acceptance: string, results: ToolResult[]) {
    const tone = results.find((r) => r.name === 'ask_user');
    return `${DEMO_BANNER}# Review\n\n**Mission:** ${goal}\n\n**Acceptance criteria:** ${acceptance || '—'}\n\n**Captain's decision on tone:** ${tone ? tone.content : '—'}\n\n## Checks\n\n- [x] Draft exists\n- [ ] Claims verified (a real reviewer would check each one)\n- [ ] Tone matches the Captain's choice\n`;
  }

  private finalReport(goal: string, h: ChatRequest['hint']) {
    const author = (id: string | null) => h.teammates.find((t) => t.id === id)?.name ?? 'the crew';
    const files = (h.depArtifacts ?? []).map((a) => `- ${a.name} (${author(a.agentId)})`).join('\n');
    return `${DEMO_BANNER}# Final report\n\n**Mission:** ${goal}\n\n## What the crew produced\n\n${files || '_Nothing was filed._'}\n\n## Summary\n\nIn demo mode this report is a template. With a real model, ${h.agent.name} would combine the crew's work into one deliverable here.\n`;
  }
}
