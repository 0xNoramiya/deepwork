// The real provider adapters, exercised against local servers that speak the
// Anthropic and OpenAI streaming wire formats. No keys or network needed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deepwork-prov-'));
process.env.DEEPWORK_DATA_DIR = path.join(tmp, 'data');
process.env.DEEPWORK_WORKSPACE_DIR = path.join(tmp, 'workspace');
for (const k of Object.keys(process.env)) if (/_API_KEY$/.test(k)) delete process.env[k];

const { AnthropicProvider } = await import('../providers/anthropic.ts');
const { OpenAIProvider } = await import('../providers/openai.ts');

type Json = Record<string, any>;
const seen: { path: string; body: Json; headers: http.IncomingHttpHeaders }[] = [];

function sse(res: http.ServerResponse, events: [string | null, Json | string][]) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const [ev, data] of events) res.write(`${ev ? `event: ${ev}\n` : ''}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
  res.end();
}

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : {};
    seen.push({ path: req.url ?? '', body, headers: req.headers });
    if (req.url?.startsWith('/anthropic/v1/messages')) {
      const second = body.messages.length > 1;
      if (!second) {
        return sse(res, [
          ['message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 120, output_tokens: 1 } } }],
          ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }],
          ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Check memory first.' } }],
          ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-abc' } }],
          ['content_block_stop', { type: 'content_block_stop', index: 0 }],
          ['content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }],
          ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Looking it up.' } }],
          ['content_block_stop', { type: 'content_block_stop', index: 1 }],
          ['content_block_start', { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'recall', input: {} } }],
          ['content_block_delta', { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"query": "cof' } }],
          ['content_block_delta', { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: 'fee"}' } }],
          ['content_block_stop', { type: 'content_block_stop', index: 2 }],
          ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 40 } }],
          ['message_stop', { type: 'message_stop' }],
        ]);
      }
      return sse(res, [
        ['message_start', { type: 'message_start', message: { id: 'msg_2', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 200, output_tokens: 1 } } }],
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Done.' } }],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }],
        ['message_stop', { type: 'message_stop' }],
      ]);
    }
    if (req.url === '/openai/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-1', object: 'model' }] }));
    }
    if (req.url === '/openai/v1/chat/completions') {
      const msgs: Json[] = body.messages;
      const sys = String(msgs[0]?.content ?? '');
      const toolMsgs = msgs.filter((m) => m.role === 'tool');
      const chunk = (delta: Json, finish: string | null = null) => ({ id: 'c', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] });
      const call = (name: string, args: Json) => {
        const s = JSON.stringify(args);
        const mid = Math.floor(s.length / 2);
        return [
          [null, chunk({ role: 'assistant', content: `Calling ${name}. ` })],
          [null, chunk({ tool_calls: [{ index: 0, id: `call_${name}`, type: 'function', function: { name, arguments: s.slice(0, mid) } }] })],
          [null, chunk({ tool_calls: [{ index: 0, function: { arguments: s.slice(mid) } }] })],
          [null, chunk({}, 'tool_calls')],
          [null, { id: 'c', object: 'chat.completion.chunk', model: body.model, choices: [], usage: { prompt_tokens: 1000, completion_tokens: 100 } }],
          [null, '[DONE]'],
        ] as [string | null, Json | string][];
      };
      if (body.model === 'mock-truncated') {
        return sse(res, [
          [null, chunk({ tool_calls: [{ index: 0, id: 'call_cut', type: 'function', function: { name: 'write_artifact', arguments: '{"name": "Half' } }] })],
          [null, chunk({}, 'length')],
          [null, '[DONE]'],
        ]);
      }
      if (sys.includes('You are the mission lead')) {
        return sse(res, call('submit_plan', { rationale: 'One task is enough.', tasks: [{ key: 'only', title: 'Write the note', description: 'Write it.', assignee: 'Solo', depends_on: [], acceptance: 'A note exists.' }] }));
      }
      if (!toolMsgs.length) return sse(res, call('write_artifact', { name: 'Note', kind: 'markdown', content: '# Note\n\nReal-path output.', description: 'The note' }));
      return sse(res, call('finish_task', { summary: 'Wrote the note.', status: 'done', artifacts: ['Note'], notes_for_team: '' }));
    }
    res.writeHead(404).end();
  });
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const port = (server.address() as { port: number }).port;
after(() => server.close());

const hint = { phase: 'task' as const, agent: {} as never, teammates: [] };

test('Anthropic adapter streams thinking, text and tool calls, and replays them verbatim', async () => {
  const p = new AnthropicProvider('ant-test', 'Anthropic test', 'sk-ant-test-key-123456', `http://127.0.0.1:${port}/anthropic`);
  const thinking: string[] = [];
  const text: string[] = [];
  const tool = { name: 'recall', description: 'Search memory', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } };
  const r1 = await p.chat({
    model: 'claude-opus-5-5', system: 'sys', messages: [{ role: 'user', content: 'hello' }], tools: [tool], effort: 'medium', maxTokens: 1000,
    signal: new AbortController().signal, onText: (d) => text.push(d), onThinking: (d) => thinking.push(d), hint,
  });
  assert.equal(r1.stopReason, 'tool_use');
  assert.deepEqual(r1.toolCalls, [{ id: 'toolu_1', name: 'recall', args: { query: 'coffee' } }]);
  assert.equal(text.join(''), 'Looking it up.');
  assert.equal(thinking.join(''), 'Check memory first.');
  assert.deepEqual(r1.usage, { input: 120, output: 40 });

  const req1 = seen.findLast((s) => s.path.startsWith('/anthropic'))!;
  assert.equal(req1.headers['x-api-key'], 'sk-ant-test-key-123456');
  assert.deepEqual(req1.body.thinking, { type: 'adaptive', display: 'summarized' });
  assert.deepEqual(req1.body.output_config, { effort: 'medium' });
  assert.equal(req1.body.temperature, undefined, 'no sampling params on new models');
  assert.equal(req1.body.fallbacks, undefined, 'server-side fallback only on the first-party API');
  assert.equal(req1.body.tools[0].eager_input_streaming, true);

  const r2 = await p.chat({
    model: 'claude-opus-5-5', system: 'sys', tools: [tool], effort: 'medium', maxTokens: 1000, signal: new AbortController().signal, hint,
    messages: [
      { role: 'user', content: 'hello' },
      { role: 'assistant', text: r1.text, toolCalls: r1.toolCalls, raw: { providerId: 'ant-test', model: 'claude-opus-5-5', content: r1.raw } },
      { role: 'user', content: 'note from the Captain', toolResults: [{ id: 'toolu_1', name: 'recall', content: 'Nothing relevant.' }] },
    ],
  });
  assert.equal(r2.stopReason, 'end');
  const req2 = seen.findLast((s) => s.path.startsWith('/anthropic'))!.body;
  const echoed = req2.messages[1].content;
  assert.equal(echoed[0].type, 'thinking');
  assert.equal(echoed[0].signature, 'sig-abc', 'thinking block echoed with its signature');
  assert.equal(echoed[2].type, 'tool_use');
  assert.deepEqual(req2.messages[2].content.map((b: Json) => b.type), ['tool_result', 'text'], 'tool results first, then the note, in one user turn');
});

test('OpenAI-compatible adapter accumulates streamed tool-call arguments', async () => {
  const p = new OpenAIProvider('oa-test', 'OpenAI test', 'openai_compat', 'sk-test-abcdef123456', `http://127.0.0.1:${port}/openai/v1`);
  assert.deepEqual(await p.listModels(), ['mock-1']);
  const r = await p.chat({
    model: 'mock-1', system: 'x', messages: [{ role: 'user', content: 'go' }], tools: [], effort: 'low', maxTokens: 500, signal: new AbortController().signal, hint,
  });
  assert.equal(r.stopReason, 'tool_use');
  assert.equal(r.toolCalls[0].name, 'write_artifact');
  assert.deepEqual(r.toolCalls[0].args, { name: 'Note', kind: 'markdown', content: '# Note\n\nReal-path output.', description: 'The note' });
  assert.deepEqual(r.usage, { input: 1000, output: 100 });
});

test('a tool call cut off at the length limit is reported as truncated, not run', async () => {
  const p = new OpenAIProvider('oa-test', 'OpenAI test', 'openai_compat', 'sk-test-abcdef123456', `http://127.0.0.1:${port}/openai/v1`);
  const r = await p.chat({ model: 'mock-truncated', system: 'x', messages: [{ role: 'user', content: 'go' }], tools: [], effort: 'low', maxTokens: 10, signal: new AbortController().signal, hint });
  assert.equal(r.stopReason, 'max_tokens');
});

test('a mission on a real (non-demo) provider completes, is billed, and is not marked simulated', async () => {
  const db = await import('../db.ts');
  const { addProvider } = await import('../providers/index.ts');
  const { orchestrator } = await import('../engine/orchestrator.ts');
  const prov = addProvider({ kind: 'openai_compat', label: 'Mock', baseUrl: `http://127.0.0.1:${port}/openai/v1`, apiKey: 'sk-mock-000000000000', defaultModel: 'mock-1' });
  db.agents.put({ id: 'solo', name: 'Solo', title: 'Generalist', role: 'Does everything.', persona: '', sprite: 'deckhand', station: 'galley', color: '#336699', providerId: prov.id, model: 'mock-1', effort: 'low', maxSteps: 8, tools: [], autoApprove: [], isLead: true, enabled: true, priceIn: 2, priceOut: 8, sort: 0 });
  const run = orchestrator.startRun('Write a short note', { requirePlanApproval: false, budgetUsd: 1 });
  const end = Date.now() + 10_000;
  let r = db.runs.get(run.id)!;
  while (!['completed', 'failed'].includes(r.status) && Date.now() < end) {
    await new Promise((x) => setTimeout(x, 20));
    r = db.runs.get(run.id)!;
  }
  assert.equal(r.status, 'completed', r.error ?? '');
  assert.equal(r.demo, false);
  assert.ok(r.spentUsd > 0, 'model calls were billed');
  // plan + write + hand in = 3 calls × (1000 in @ $2/M + 100 out @ $8/M); one-task missions skip the synthesis call
  assert.ok(Math.abs(r.spentUsd - (3 * (1000 * 2 + 100 * 8)) / 1e6) < 1e-9, `spent ${r.spentUsd}`);
  const art = db.artifacts.get(r.finalArtifactId!)!;
  assert.equal(art.demo, false);
  assert.match(db.artifacts.content(art.id)!, /Real-path output/);
  const stored = db.db.prepare('SELECT key_enc FROM providers WHERE id = ?').get(prov.id) as { key_enc: string };
  assert.ok(!stored.key_enc.includes('sk-mock'), 'key is encrypted at rest');
});
