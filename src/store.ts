import { create } from 'zustand';
import type {
  AgentLive,
  ChatMessage,
  DecisionRequest,
  LogEvent,
  Run,
  ServerMessage,
  Snapshot,
} from '../shared/types.ts';
import { DEFAULT_LIMITS } from '../shared/defaults.ts';
import { api } from './api.ts';

interface Preset {
  id: string;
  kind: 'anthropic' | 'openai' | 'openai_compat';
  label: string;
  baseUrl: string | null;
  envVar: string;
  defaultModel: string;
  needsKey: boolean;
}

interface Stream {
  text: string;
  thinking: string;
  taskId: string | null;
  at: number;
}

type FxKind = 'capsule' | 'parcel' | 'note' | 'done' | 'ask' | 'answer' | 'stamp';
export interface Fx {
  id: number;
  kind: FxKind;
  agentId?: string;
  toId?: string;
  text?: string;
  at: number;
}

export type Tab = 'mission' | 'crew' | 'archive' | 'log';

interface State extends Omit<Snapshot, 'live'> {
  ready: boolean;
  connected: boolean;
  live: Record<string, AgentLive>;
  held: string[];
  presets: Preset[];
  configurableTools: string[];
  chats: Record<string, ChatMessage[]>;
  streams: Record<string, Stream>;
  chatStreams: Record<string, string>;
  fx: Fx[];
  tab: Tab;
  selectedAgent: string | null;
  selectedTask: string | null;
  openArtifact: string | null;
  settingsOpen: boolean;
  haulOpen: boolean;
  hireOpen: boolean;
  toast: { id: number; text: string; tone: 'info' | 'warn' | 'error'; action?: { label: string; run: () => void } } | null;
  load(): Promise<void>;
  apply(msg: ServerMessage): void;
  set(p: Partial<State>): void;
  selectAgent(id: string | null): void;
  selectTask(id: string | null): void;
  showArtifact(id: string | null): void;
  notify(text: string, tone?: 'info' | 'warn' | 'error', action?: { label: string; run: () => void }): void;
  loadChat(agentId: string): Promise<void>;
}

const upsert = <T extends { id: string }>(list: T[], item: T, front = false): T[] => {
  const i = list.findIndex((x) => x.id === item.id);
  if (i === -1) return front ? [item, ...list] : [...list, item];
  const next = list.slice();
  next[i] = item;
  return next;
};

const TAB_KEY = 'deepwork.tab';
function savedTab(): Tab {
  try {
    const t = localStorage.getItem(TAB_KEY);
    return t === 'crew' || t === 'archive' || t === 'log' ? t : 'mission';
  } catch {
    return 'mission';
  }
}

let fxId = 1;
let toastId = 1;
let serverStart = 0;

function fxFor(e: LogEvent): Omit<Fx, 'id' | 'at'> | null {
  const d = e.data ?? {};
  switch (e.type) {
    case 'handoff':
      return { kind: 'capsule', agentId: String(d.fromId), toId: String(d.toId) };
    case 'artifact_written':
      return { kind: 'parcel', agentId: e.agentId ?? undefined };
    case 'memory_written':
      return { kind: 'note', agentId: e.agentId ?? undefined };
    case 'task_done':
      return { kind: 'done', agentId: e.agentId ?? undefined };
    case 'consult_start':
      return { kind: 'ask', agentId: e.agentId ?? undefined, toId: String(d.targetId), text: e.summary.replace(/^.*?: /, '') };
    case 'consult_answer':
      return { kind: 'answer', agentId: e.agentId ?? undefined, toId: String(d.askerId), text: String(d.answer ?? '') };
    case 'approval_granted':
      return { kind: 'stamp', text: 'APPROVED' };
    case 'approval_denied':
      return { kind: 'stamp', text: 'DENIED' };
    default:
      return null;
  }
}

export const useStore = create<State>((set, get) => ({
  ready: false,
  connected: false,
  agents: [],
  live: {},
  providers: [],
  run: null,
  runs: [],
  tasks: [],
  artifacts: [],
  requests: [],
  events: [],
  memories: [],
  charter: '',
  defaults: DEFAULT_LIMITS,
  toolCatalog: [],
  held: [],
  presets: [],
  configurableTools: [],
  chats: {},
  streams: {},
  chatStreams: {},
  fx: [],
  tab: savedTab(),
  selectedAgent: null,
  selectedTask: null,
  openArtifact: null,
  settingsOpen: false,
  haulOpen: false,
  hireOpen: false,
  toast: null,

  async load() {
    const s = await api.get<Snapshot & { held: string[]; presets: Preset[]; configurableTools: string[] }>('/api/state');
    set({
      ...s,
      live: Object.fromEntries(s.live.map((l) => [l.agentId, l])),
      ready: true,
    });
  },

  set(p) {
    set(p);
  },

  selectAgent(id) {
    set({ selectedAgent: id, tab: id ? 'crew' : get().tab, openArtifact: id ? null : get().openArtifact });
    if (id) void get().loadChat(id);
  },
  selectTask(id) {
    set({ selectedTask: id, tab: id ? 'mission' : get().tab });
  },
  showArtifact(id) {
    set({ openArtifact: id, tab: id ? 'archive' : get().tab });
  },
  notify(text, tone = 'info', action) {
    const id = toastId++;
    set({ toast: { id, text, tone, action } });
    setTimeout(() => {
      if (get().toast?.id === id) set({ toast: null });
    }, 7000);
  },
  async loadChat(agentId) {
    const msgs = await api.get<ChatMessage[]>(`/api/agents/${agentId}/chat`);
    set({ chats: { ...get().chats, [agentId]: msgs } });
  },

  apply(msg) {
    const s = get();
    switch (msg.kind) {
      case 'hello':
        if (serverStart && serverStart !== msg.serverStart) void s.load();
        serverStart = msg.serverStart;
        return;
      case 'charter':
        return set({ charter: msg.data });
      case 'remove': {
        const keep = <T extends { id: string }>(list: T[]) => list.filter((x) => x.id !== msg.id);
        if (msg.entity === 'agent') return set({ agents: keep(s.agents) });
        if (msg.entity === 'task') return set({ tasks: keep(s.tasks) });
        if (msg.entity === 'memory') return set({ memories: keep(s.memories) });
        return set({ providers: keep(s.providers) });
      }
      case 'stream': {
        if (msg.taskId === 'chat') {
          const prev = msg.reset ? '' : (s.chatStreams[msg.agentId] ?? '');
          return set({ chatStreams: { ...s.chatStreams, [msg.agentId]: (prev + msg.delta).slice(-6000) } });
        }
        const prev = s.streams[msg.agentId];
        const base: Stream = msg.reset || !prev || prev.taskId !== msg.taskId ? { text: '', thinking: '', taskId: msg.taskId, at: Date.now() } : prev;
        const next: Stream = {
          ...base,
          at: Date.now(),
          text: msg.channel === 'text' ? (base.text + msg.delta).slice(-8000) : base.text,
          thinking: msg.channel === 'thinking' ? (base.thinking + msg.delta).slice(-8000) : base.thinking,
        };
        return set({ streams: { ...s.streams, [msg.agentId]: next } });
      }
      case 'event': {
        const e = msg.data;
        if (e.runId && s.run && e.runId !== s.run.id) return;
        const f = fxFor(e);
        const now = Date.now();
        set({
          events: [...s.events.slice(-799), e],
          fx: f ? [...s.fx.filter((x) => now - x.at < 12_000), { ...f, id: fxId++, at: now }] : s.fx,
        });
        if (e.type === 'run_completed') set({ haulOpen: true });
        if ((e.type === 'question_asked' || e.type === 'approval_requested') && (get().tab !== 'mission' || get().selectedTask)) {
          s.notify(e.summary, 'warn', { label: 'Answer', run: () => get().set({ tab: 'mission', selectedTask: null }) });
        }
        if (e.type === 'task_failed' || e.type === 'run_failed') s.notify(e.summary, 'error');
        if (e.type === 'budget_exhausted') s.notify(e.summary, 'warn');
        return;
      }
      case 'upsert':
        switch (msg.entity) {
          case 'agent':
            return set({ agents: upsert(s.agents, msg.data).sort((a, b) => a.sort - b.sort) });
          case 'live':
            return set({ live: { ...s.live, [msg.data.agentId]: msg.data } });
          case 'provider':
            return set({ providers: upsert(s.providers, msg.data) });
          case 'memory':
            return set({ memories: upsert(s.memories, msg.data, true) });
          case 'artifact':
            return set({ artifacts: upsert(s.artifacts, msg.data, true) });
          case 'chat': {
            const list = s.chats[msg.data.agentId] ?? [];
            const chatStreams = msg.data.role === 'agent' ? { ...s.chatStreams, [msg.data.agentId]: '' } : s.chatStreams;
            return set({ chats: { ...s.chats, [msg.data.agentId]: upsert(list, msg.data) }, chatStreams });
          }
          case 'request':
            return set({ requests: upsert(s.requests, msg.data) });
          case 'task':
            if (s.run && msg.data.runId !== s.run.id) return;
            return set({ tasks: upsert(s.tasks, msg.data).sort((a, b) => a.order - b.order) });
          case 'run': {
            const r: Run = msg.data;
            const runs = upsert(s.runs, r, true);
            if (!s.run || s.run.id === r.id) return set({ run: r, runs });
            // A new mission replaced the one on screen.
            return set({ run: r, runs, tasks: [], events: [], requests: s.requests.filter((q) => q.status === 'open'), streams: {}, fx: [], selectedTask: null, haulOpen: false });
          }
        }
    }
  },
}));

useStore.subscribe((s, prev) => {
  if (s.tab === prev.tab) return;
  try {
    localStorage.setItem(TAB_KEY, s.tab);
  } catch {
    // Private windows can refuse storage; the tab just won't be remembered.
  }
});

export function connect() {
  const es = new EventSource('/api/stream');
  let hadError = false;
  es.onopen = () => {
    useStore.getState().set({ connected: true });
    if (hadError) void useStore.getState().load();
    hadError = false;
  };
  es.onerror = () => {
    hadError = true;
    useStore.getState().set({ connected: false });
  };
  es.onmessage = (ev) => useStore.getState().apply(JSON.parse(ev.data) as ServerMessage);
  return () => es.close();
}

export const openRequests = (reqs: DecisionRequest[]) => reqs.filter((q) => q.status === 'open');
