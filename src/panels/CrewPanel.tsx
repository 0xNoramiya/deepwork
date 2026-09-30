import { useEffect, useRef, useState } from 'react';
import type { Agent, ChatMessage, RoomId, SpriteId } from '../../shared/types.ts';
import { api, errorMessage } from '../api.ts';
import { Icon } from '../icons.tsx';
import { useStore } from '../store.ts';
import { ACTIVITY_LABEL, clock, cx, face, sentence } from '../util.ts';
import { ROOMS } from '../world/layout.ts';

// A stable empty list: a selector that returns a fresh [] each call re-renders forever.
const NO_CHATS: ChatMessage[] = [];
const SPRITES: SpriteId[] = ['navigator', 'sonar', 'writer', 'engineer', 'inspector', 'deckhand', 'quartermaster'];
const STATIONS = ROOMS.filter((r) => ['chart', 'sonar', 'cabin', 'lab', 'workshop', 'engine', 'archive', 'galley'].includes(r.id));
const TOOL_HELP: Record<string, string> = {
  remember: 'Save facts to shared memory',
  ask_teammate: 'Ask crewmates questions',
  web_fetch: 'Read public web pages (asks you first)',
  http_request: 'Send HTTP requests (asks you every time)',
};

function Roster() {
  const agents = useStore((s) => s.agents);
  const live = useStore((s) => s.live);
  const held = useStore((s) => s.held);
  const selectAgent = useStore((s) => s.selectAgent);
  const set = useStore((s) => s.set);
  const nameOf = (id: string) => agents.find((a) => a.id === id)?.name ?? '?';
  return (
    <div className="panel roster">
      <div className="section-head">
        <h2>Crew</h2>
        <button type="button" className="btn" onClick={() => set({ hireOpen: true, selectedAgent: null })}>
          Hire
        </button>
      </div>
      <ul>
        {agents.map((a) => (
          <li key={a.id}>
            <button type="button" className={cx('crew-row', !a.enabled && 'off')} onClick={() => selectAgent(a.id)}>
              <img src={face(a)} alt="" />
              <span className="crew-row-main">
                <b>
                  {a.name} <span className="muted">· {a.title}</span>
                  {a.isLead && <span className="tag">lead</span>}
                  {held.includes(a.id) && <span className="tag warn">on hold</span>}
                </b>
                <span className="small">{a.enabled ? sentence(live[a.id], nameOf) : 'Off duty.'}</span>
                <span className="small muted mono">{a.providerId === 'demo' ? 'demo · simulated' : a.providerId ? a.model : 'no model'}</span>
              </span>
              <span className={cx('act-dot', `a-${live[a.id]?.activity ?? 'idle'}`)} title={ACTIVITY_LABEL[live[a.id]?.activity ?? 'idle']} />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function LiveFeed({ agent }: { agent: Agent }) {
  const stream = useStore((s) => s.streams[agent.id]);
  const activity = useStore((s) => s.live[agent.id]?.activity);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight });
  }, [stream?.text, stream?.thinking]);
  if (!stream || (!stream.text && !stream.thinking)) {
    const thinking = activity === 'working' || activity === 'planning';
    return <p className="muted small">{thinking ? 'Thinking. Output appears here as soon as the model starts writing.' : 'Nothing streaming right now.'}</p>;
  }
  return (
    <div className="feed" ref={ref}>
      {agent.providerId === 'demo' && <span className="sim-badge">simulated, not a model</span>}
      {stream.thinking && <p className="feed-thinking">{stream.thinking}</p>}
      {stream.text && <p className="feed-text">{stream.text}</p>}
    </div>
  );
}

function Chat({ agent }: { agent: Agent }) {
  const chats = useStore((s) => s.chats[agent.id] ?? NO_CHATS);
  const pending = useStore((s) => s.chatStreams[agent.id] ?? '');
  const live = useStore((s) => s.live[agent.id]);
  const notify = useStore((s) => s.notify);
  const working = ['working', 'planning', 'waiting_user', 'waiting_approval', 'consulting'].includes(live?.activity ?? '');
  const [mode, setMode] = useState<'ask' | 'redirect'>('ask');
  const [text, setText] = useState('');
  const list = useRef<HTMLOListElement>(null);
  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight });
  }, [chats.length, pending]);
  const send = async () => {
    if (!text.trim()) return;
    try {
      await api.post(`/api/agents/${agent.id}/chat`, { text: text.trim(), mode });
      setText('');
    } catch (e) {
      notify(errorMessage(e), 'error');
    }
  };
  return (
    <div className="chat">
      {!chats.length && !pending && (
        <p className="muted small">Ask about their work at any time. While they're on a task, Redirect changes what they do next.</p>
      )}
      <ol ref={list}>
        {chats.map((m) => (
          <li key={m.id} className={cx(`c-${m.role}`, m.error && 'err', m.mode === 'redirect' && 'redirect')}>
            {m.role === 'user' && m.mode === 'redirect' && <span className="tag">redirect</span>}
            {m.demo && <span className="sim-badge">simulated</span>}
            <p>{m.content}</p>
            <time>{clock(m.ts)}</time>
          </li>
        ))}
        {pending && (
          <li className="c-agent streaming">
            <p>{pending}</p>
          </li>
        )}
      </ol>
      <div className="chat-mode" role="radiogroup" aria-label="Message type">
        <button type="button" role="radio" aria-checked={mode === 'ask'} className={cx(mode === 'ask' && 'on')} onClick={() => setMode('ask')} title="A side conversation. Doesn't interrupt their work.">
          Ask
        </button>
        <button type="button" role="radio" aria-checked={mode === 'redirect'} className={cx(mode === 'redirect' && 'on')} disabled={!working} onClick={() => setMode('redirect')} title={working ? 'Delivered into their current task at the next step' : 'Only while they are working on a task'}>
          Redirect their work
        </button>
      </div>
      <form
        className="free"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder={mode === 'ask' ? `Ask ${agent.name} anything…` : `New direction for ${agent.name}'s current task…`} />
        <button type="submit" className="icon-btn" disabled={!text.trim()} aria-label="Send">
          <Icon name="send" />
        </button>
      </form>
    </div>
  );
}

type Draft = Omit<Agent, 'id' | 'sort'>;

export function AgentForm({ initial, onDone }: { initial?: Agent; onDone: () => void }) {
  const providers = useStore((s) => s.providers);
  const notify = useStore((s) => s.notify);
  const configurable = useStore((s) => s.configurableTools);
  const [models, setModels] = useState<string[]>([]);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [d, setD] = useState<Draft>(
    initial ?? {
      name: '',
      title: '',
      role: '',
      persona: '',
      sprite: 'deckhand',
      station: 'galley',
      color: '#3f7f6a',
      providerId: providers.find((p) => p.kind !== 'demo' && p.keySource !== 'none')?.id ?? 'demo',
      model: providers.find((p) => p.kind !== 'demo' && p.keySource !== 'none')?.defaultModel ?? 'simulated',
      effort: 'medium',
      maxSteps: 14,
      tools: ['remember', 'ask_teammate'],
      autoApprove: [],
      isLead: false,
      enabled: true,
      priceIn: null,
      priceOut: null,
    },
  );
  const provider = providers.find((p) => p.id === d.providerId);
  useEffect(() => {
    setModels([]);
    setModelsError(null);
    if (!d.providerId || d.providerId === 'demo') return;
    api
      .post<{ ok: boolean; models?: string[]; error?: string }>(`/api/providers/${d.providerId}/test`)
      .then((r) => (r.ok ? setModels(r.models ?? []) : setModelsError(r.error ?? 'unknown error')))
      .catch((e) => setModelsError(errorMessage(e)));
  }, [d.providerId]);

  const save = async () => {
    try {
      if (initial) await api.patch(`/api/agents/${initial.id}`, d);
      else await api.post('/api/agents', d);
      onDone();
    } catch (e) {
      notify(errorMessage(e), 'error');
    }
  };
  const field = <K extends keyof Draft>(k: K, v: Draft[K]) => setD({ ...d, [k]: v });

  return (
    <div className="agent-form">
      <div className="sprite-pick">
        {SPRITES.map((s) => (
          <button key={s} type="button" className={cx(d.sprite === s && 'on')} onClick={() => field('sprite', s)} aria-label={s}>
            <img src={`/art/crew/${s}-face.webp`} alt="" />
          </button>
        ))}
      </div>
      <div className="grid2">
        <label>
          <span>Name</span>
          <input value={d.name} onChange={(e) => field('name', e.target.value)} />
        </label>
        <label>
          <span>Title</span>
          <input value={d.title} onChange={(e) => field('title', e.target.value)} placeholder="e.g. Analyst" />
        </label>
      </div>
      <label>
        <span>Responsibility</span>
        <textarea rows={2} value={d.role} onChange={(e) => field('role', e.target.value)} placeholder="What this crew member owns. The lead uses this to assign work." />
      </label>
      <label>
        <span>How they work</span>
        <textarea rows={3} value={d.persona} onChange={(e) => field('persona', e.target.value)} placeholder="Style, standards, things to always or never do." />
      </label>
      <div className="grid2">
        <label>
          <span>Provider</span>
          <select
            value={d.providerId ?? ''}
            onChange={(e) => {
              const p = providers.find((x) => x.id === e.target.value);
              setD({ ...d, providerId: e.target.value, model: p?.defaultModel || (p?.kind === 'demo' ? 'simulated' : d.model) });
            }}
          >
            {providers.map((p) => (
              <option key={p.id} value={p.id} disabled={p.kind !== 'demo' && p.keySource === 'none' && !/localhost/.test(p.baseUrl ?? '')}>
                {p.label}
                {p.kind !== 'demo' && p.keySource === 'none' && !/localhost/.test(p.baseUrl ?? '') ? ' (no key)' : ''}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Model</span>
          <input list={`models-${initial?.id ?? 'new'}`} value={d.model} disabled={provider?.kind === 'demo'} onChange={(e) => field('model', e.target.value)} />
          <datalist id={`models-${initial?.id ?? 'new'}`}>
            {models.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
          {modelsError && <span className="small warn-text">Couldn't list models: {modelsError}</span>}
        </label>
      </div>
      <div className="grid2">
        <label>
          <span>Effort</span>
          <select value={d.effort} onChange={(e) => field('effort', e.target.value as Draft['effort'])}>
            <option value="low">Low: fast and cheap</option>
            <option value="medium">Medium</option>
            <option value="high">High: thorough</option>
          </select>
        </label>
        <label>
          <span>Station</span>
          <select value={d.station} onChange={(e) => field('station', e.target.value as RoomId)}>
            {STATIONS.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <fieldset>
        <legend>Tools</legend>
        {configurable.map((t) => (
          <label key={t} className="check small">
            <input type="checkbox" checked={d.tools.includes(t)} onChange={(e) => field('tools', e.target.checked ? [...d.tools, t] : d.tools.filter((x) => x !== t))} />
            <span>
              <code>{t}</code> {TOOL_HELP[t]}
            </span>
          </label>
        ))}
        <label className="check small">
          <input type="checkbox" checked={d.autoApprove.includes('web_fetch')} disabled={!d.tools.includes('web_fetch')} onChange={(e) => field('autoApprove', e.target.checked ? ['web_fetch'] : [])} />
          <span>Read web pages without asking me first</span>
        </label>
        <p className="muted small">Writing files, reading the archive, memory lookups and handing in are always available. Sending HTTP requests always needs your approval.</p>
      </fieldset>
      <div className="grid2">
        <label>
          <span>Price in $/M tokens</span>
          <input type="number" min="0" step="0.1" placeholder="auto" value={d.priceIn ?? ''} onChange={(e) => field('priceIn', e.target.value === '' ? null : Number(e.target.value))} />
        </label>
        <label>
          <span>Price out $/M tokens</span>
          <input type="number" min="0" step="0.1" placeholder="auto" value={d.priceOut ?? ''} onChange={(e) => field('priceOut', e.target.value === '' ? null : Number(e.target.value))} />
        </label>
      </div>
      <label className="check small">
        <input type="checkbox" checked={d.isLead} onChange={(e) => field('isLead', e.target.checked)} />
        <span>Mission lead (plans missions and writes final reports)</span>
      </label>
      <label className="check small">
        <input type="checkbox" checked={d.enabled} onChange={(e) => field('enabled', e.target.checked)} />
        <span>On duty</span>
      </label>
      <div className="row">
        <button type="button" className="btn primary" disabled={!d.name || !d.title || d.role.length < 3} onClick={() => void save()}>
          {initial ? 'Save' : 'Hire'}
        </button>
        <button type="button" className="btn ghost" onClick={onDone}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function AgentDetail({ agent }: { agent: Agent }) {
  const live = useStore((s) => s.live[agent.id]);
  const agents = useStore((s) => s.agents);
  const tasks = useStore((s) => s.tasks);
  const held = useStore((s) => s.held);
  const selectAgent = useStore((s) => s.selectAgent);
  const selectTask = useStore((s) => s.selectTask);
  const notify = useStore((s) => s.notify);
  const set = useStore((s) => s.set);
  const [editing, setEditing] = useState(false);
  const nameOf = (id: string) => agents.find((a) => a.id === id)?.name ?? '?';
  const isHeld = held.includes(agent.id);
  const mine = tasks.filter((t) => t.assigneeId === agent.id);

  const hold = async () => {
    try {
      await api.post(`/api/agents/${agent.id}/hold`, { on: !isHeld });
      set({ held: isHeld ? held.filter((h) => h !== agent.id) : [...held, agent.id] });
    } catch (e) {
      notify(errorMessage(e), 'error');
    }
  };
  const remove = async () => {
    if (!confirm(`Remove ${agent.name} from the crew? Their files and memories stay.`)) return;
    try {
      await api.del(`/api/agents/${agent.id}`);
      selectAgent(null);
    } catch (e) {
      notify(errorMessage(e), 'error');
    }
  };

  return (
    <div className="panel agent">
      <button type="button" className="back" onClick={() => selectAgent(null)}>
        <Icon name="back" /> Crew
      </button>
      <header className="agent-head">
        <img src={face(agent)} alt="" style={{ borderColor: agent.color }} />
        <div>
          <h2>
            {agent.name} {agent.isLead && <span className="tag">lead</span>}
          </h2>
          <p className="muted">{agent.title}</p>
          <p className="mono small">
            {agent.providerId === 'demo' ? <span className="sim-badge">demo · simulated</span> : `${agent.model} · effort ${agent.effort}`}
          </p>
        </div>
      </header>
      <p className="status-line">
        <span className={cx('act-dot', `a-${live?.activity ?? 'idle'}`)} /> {agent.enabled ? sentence(live, nameOf) : 'Off duty.'}
      </p>
      <p className="muted small">{agent.role}</p>
      <div className="row">
        <button type="button" className={cx('btn', isHeld && 'primary')} onClick={() => void hold()} title="A held agent finishes their current step, then waits. They get no new tasks.">
          {isHeld ? 'Release' : 'Hold'}
        </button>
        <button type="button" className="btn ghost" onClick={() => setEditing(!editing)}>
          {editing ? 'Close settings' : 'Settings'}
        </button>
      </div>
      {editing && <AgentForm initial={agent} onDone={() => setEditing(false)} />}

      {mine.length > 0 && (
        <section>
          <h3>Tasks this mission</h3>
          <ul className="file-list">
            {mine.map((t) => (
              <li key={t.id}>
                <button type="button" onClick={() => selectTask(t.id)}>
                  <span className={cx('pill', `st-${t.status}`)}>{t.status.replace('_', ' ')}</span> {t.title}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h3>Live</h3>
        <LiveFeed agent={agent} />
      </section>

      <section>
        <h3>Talk to {agent.name}</h3>
        <Chat agent={agent} />
      </section>

      {!agent.isLead && (
        <button type="button" className="link danger small" onClick={() => void remove()}>
          Remove from crew
        </button>
      )}
    </div>
  );
}

export function CrewPanel() {
  const selected = useStore((s) => s.selectedAgent);
  const agent = useStore((s) => s.agents.find((a) => a.id === selected));
  const hireOpen = useStore((s) => s.hireOpen);
  const set = useStore((s) => s.set);
  if (hireOpen) {
    return (
      <div className="panel">
        <button type="button" className="back" onClick={() => set({ hireOpen: false })}>
          <Icon name="back" /> Crew
        </button>
        <h2>Hire a crew member</h2>
        <p className="muted">Give them a clear responsibility. The lead reads it when deciding who does what.</p>
        <AgentForm onDone={() => set({ hireOpen: false })} />
      </div>
    );
  }
  return agent ? <AgentDetail agent={agent} /> : <Roster />;
}
