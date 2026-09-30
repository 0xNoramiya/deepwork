import { useState } from 'react';
import { useStore } from '../store.ts';
import { clock, cx, face } from '../util.ts';

type Filter = 'important' | 'all' | 'problems';
const FILTERS: Filter[] = ['important', 'all', 'problems'];

export function LogPanel() {
  const events = useStore((s) => s.events);
  const agents = useStore((s) => s.agents);
  const [filter, setFilter] = useState<Filter>('important');
  const [who, setWho] = useState<string>('');
  const shown = events
    .filter((e) => (filter === 'all' ? true : filter === 'problems' ? e.level === 'warn' || e.level === 'error' : e.level !== 'debug'))
    .filter((e) => !who || e.agentId === who)
    .slice(-400)
    .reverse();
  return (
    <div className="panel log">
      <div className="section-head">
        <h2>Log</h2>
        <div className="seg">
          {FILTERS.map((f) => (
            <button key={f} type="button" className={cx(filter === f && 'on')} onClick={() => setFilter(f)}>
              {f === 'important' ? 'Highlights' : f === 'all' ? 'Everything' : 'Problems'}
            </button>
          ))}
        </div>
      </div>
      <select className="who" value={who} onChange={(e) => setWho(e.target.value)}>
        <option value="">Whole crew</option>
        {agents.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
      </select>
      {filter === 'all' && <p className="muted small">Includes every model call (tokens, cost, time) and every tool call with its arguments and result.</p>}
      <ol className="events">
        {shown.map((e) => {
          const a = agents.find((x) => x.id === e.agentId);
          const detail = e.data && (e.type === 'tool_call' || e.type === 'model_call' || e.level === 'error');
          return (
            <li key={e.id} className={`lvl-${e.level}`}>
              <time>{clock(e.ts)}</time>
              {a ? <img src={face(a)} alt={a.name} /> : <i className="dot" />}
              {detail ? (
                <details>
                  <summary>{e.summary}</summary>
                  <pre>{JSON.stringify(e.data, null, 2).slice(0, 5000)}</pre>
                </details>
              ) : (
                <span>{e.summary}</span>
              )}
            </li>
          );
        })}
      </ol>
      {!shown.length && (
        <div className="empty-state">
          <b>{events.length ? 'Nothing matches this filter' : 'Nothing logged yet'}</b>
          <span>{events.length ? 'Switch to Everything to see every model call and tool call.' : 'Events show up here as soon as a mission starts.'}</span>
        </div>
      )}
    </div>
  );
}
