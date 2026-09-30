import type { Activity, Agent, AgentLive, RunStatus, TaskStatus } from '../shared/types.ts';

export const money = (n: number) => (n < 0.01 && n > 0 ? '<$0.01' : `$${n.toFixed(2)}`);

export const tokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

export function ago(ts: number, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return new Date(ts).toLocaleDateString();
}

export const clock = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

export const sprite = (a: Pick<Agent, 'sprite'>) => `/art/crew/${a.sprite}.webp`;
export const face = (a: Pick<Agent, 'sprite'>) => `/art/crew/${a.sprite}-face.webp`;

export const RUN_LABEL: Record<RunStatus, string> = {
  planning: 'Planning',
  review: 'Plan ready for review',
  running: 'Under way',
  paused: 'All stop',
  synthesizing: 'Writing the final report',
  completed: 'Mission complete',
  failed: 'Mission failed',
  cancelled: 'Cancelled',
};

export const TASK_LABEL: Record<TaskStatus, string> = {
  pending: 'Queued',
  running: 'Working',
  waiting_user: 'Needs your answer',
  waiting_approval: 'Needs approval',
  done: 'Done',
  blocked: 'Stuck',
  failed: 'Failed',
  cancelled: 'Cancelled',
  skipped: 'Skipped',
};

export const ACTIVITY_LABEL: Record<Activity, string> = {
  idle: 'Idle',
  planning: 'Planning',
  working: 'Working',
  waiting_dep: 'Waiting on a teammate',
  waiting_user: 'Waiting for you',
  waiting_approval: 'Waiting for approval',
  consulting: 'Asking a teammate',
  consulted: 'Answering a teammate',
  chatting: 'Talking to you',
  filing: 'Filing work',
  blocked: 'Stuck',
  failed: 'Failed',
  paused: 'Paused',
  off_duty: 'Off duty',
};

export function sentence(l: AgentLive | undefined, nameOf: (id: string) => string) {
  if (!l) return 'Idle.';
  switch (l.activity) {
    case 'waiting_dep':
      return l.blockedBy.length ? `Waiting on ${l.blockedBy.map(nameOf).join(' & ')} before starting.` : `${l.detail ?? 'Waiting'}.`;
    case 'consulting':
      return `Asking ${l.withAgentId ? nameOf(l.withAgentId) : 'a teammate'} a question.`;
    case 'working':
    case 'planning':
      return l.detail ? `${l.detail[0].toUpperCase()}${l.detail.slice(1)}${l.maxSteps ? ` (step ${l.step} of ${l.maxSteps})` : ''}.` : `${ACTIVITY_LABEL[l.activity]}.`;
    default:
      return l.detail ? `${ACTIVITY_LABEL[l.activity]}: ${l.detail}.` : `${ACTIVITY_LABEL[l.activity]}.`;
  }
}

export const cx = (...xs: (string | false | null | undefined)[]) => xs.filter(Boolean).join(' ');
