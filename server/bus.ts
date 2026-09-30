import type { Response } from 'express';
import type { EventLevel, LogEvent, ServerMessage } from '../shared/types.ts';
import { events } from './db.ts';
import { redact } from './secrets.ts';

const clients = new Set<Response>();

export function subscribe(res: Response) {
  clients.add(res);
  res.on('close', () => clients.delete(res));
}

export function broadcast(msg: ServerMessage) {
  const line = `data: ${redact(JSON.stringify(msg))}\n\n`;
  for (const c of clients) c.write(line);
}

// Token streams are chatty; coalesce them into ~60ms frames per agent so the
// browser gets smooth text without thousands of tiny messages.
const pending = new Map<string, { agentId: string; taskId: string | null; channel: 'text' | 'thinking'; delta: string }>();
let flushTimer: NodeJS.Timeout | null = null;

export function streamDelta(agentId: string, taskId: string | null, channel: 'text' | 'thinking', delta: string) {
  const key = `${agentId}:${channel}`;
  const cur = pending.get(key);
  if (cur && cur.taskId === taskId) cur.delta += delta;
  else pending.set(key, { agentId, taskId, channel, delta });
  flushTimer ??= setTimeout(flushStreams, 60);
}

export function streamReset(agentId: string, taskId: string | null) {
  flushStreams();
  broadcast({ kind: 'stream', agentId, taskId, channel: 'text', delta: '', reset: true });
}

function flushStreams() {
  flushTimer = null;
  for (const p of pending.values()) broadcast({ kind: 'stream', ...p });
  pending.clear();
}

export function log(
  e: { runId?: string | null; taskId?: string | null; agentId?: string | null; type: string; level?: EventLevel; summary: string; data?: Record<string, unknown> | null },
): LogEvent {
  const saved = events.insert({
    runId: e.runId ?? null,
    taskId: e.taskId ?? null,
    agentId: e.agentId ?? null,
    type: e.type,
    level: e.level ?? 'info',
    summary: redact(e.summary),
    data: e.data ?? null,
    ts: Date.now(),
  });
  broadcast({ kind: 'event', data: saved });
  return saved;
}
