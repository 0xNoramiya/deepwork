import type { Activity, AgentLive } from '../../shared/types.ts';
import { broadcast } from '../bus.ts';

// What each agent is doing right now. This is derived from the engine, never
// scripted: every change here corresponds to a real transition in a task loop.
const live = new Map<string, AgentLive>();

function blank(agentId: string): AgentLive {
  return { agentId, activity: 'idle', runId: null, taskId: null, detail: null, withAgentId: null, blockedBy: [], step: 0, maxSteps: 0, requestId: null, since: Date.now() };
}

export function getLive(agentId: string): AgentLive {
  return live.get(agentId) ?? blank(agentId);
}

export function allLive(): AgentLive[] {
  return [...live.values()];
}

export function setLive(agentId: string, patch: Partial<Omit<AgentLive, 'agentId'>> & { activity?: Activity }) {
  const prev = getLive(agentId);
  const next: AgentLive = { ...prev, ...patch, agentId };
  if (patch.activity && patch.activity !== prev.activity) next.since = Date.now();
  const changed = JSON.stringify({ ...prev, since: 0 }) !== JSON.stringify({ ...next, since: 0 });
  live.set(agentId, next);
  if (changed) broadcast({ kind: 'upsert', entity: 'live', data: next });
}

export function resetLive(agentId: string, activity: Activity = 'idle') {
  const next = { ...blank(agentId), activity };
  live.set(agentId, next);
  broadcast({ kind: 'upsert', entity: 'live', data: next });
}
