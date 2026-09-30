import { useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Artifact } from '../../shared/types.ts';
import { api, errorMessage } from '../api.ts';
import { Icon } from '../icons.tsx';
import { useStore } from '../store.ts';
import { ago, clip, cx, face, plural } from '../util.ts';

function Csv({ text }: { text: string }) {
  const rows = text
    .trim()
    .split(/\r?\n/)
    .slice(0, 300)
    .map((l) => l.match(/("([^"]|"")*"|[^,]*)(,|$)/g)?.map((c) => c.replace(/,$/, '').replace(/^"|"$/g, '').replace(/""/g, '"')) ?? []);
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>{rows[0]?.map((c, i) => <th key={i}>{c}</th>)}</tr>
        </thead>
        <tbody>
          {rows.slice(1).map((r, i) => (
            <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ArtifactBody({ artifact, content }: { artifact: Artifact; content: string }) {
  if (artifact.kind === 'markdown' || artifact.kind === 'text') {
    return (
      <div className="prose">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
      </div>
    );
  }
  if (artifact.kind === 'csv') return <Csv text={content} />;
  if (artifact.kind === 'html') {
    return (
      <div className="html-preview">
        <p className="muted small">Sandboxed preview: scripts run in isolation with no network access.</p>
        <iframe title={artifact.name} sandbox="allow-scripts" src={`/api/artifacts/${artifact.id}/preview`} />
        <details>
          <summary>Source</summary>
          <pre className="code">{content}</pre>
        </details>
      </div>
    );
  }
  let shown = content;
  if (artifact.kind === 'json') {
    try {
      shown = JSON.stringify(JSON.parse(content), null, 2);
    } catch {
      /* show as written */
    }
  }
  return <pre className="code">{shown}</pre>;
}

export function ArtifactViewer({ id, onBack }: { id: string; onBack?: () => void }) {
  const agents = useStore((s) => s.agents);
  const runs = useStore((s) => s.runs);
  const artifactMeta = useStore((s) => s.artifacts.find((a) => a.id === id));
  const [data, setData] = useState<{ artifact: Artifact; content: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api
      .get<{ artifact: Artifact; content: string }>(`/api/artifacts/${id}`)
      .then(setData)
      .catch((e) => setErr(errorMessage(e)));
  }, [id, artifactMeta?.version]);
  if (err) return <p className="warn-text">{err}</p>;
  if (!data) return <p className="muted">Opening…</p>;
  const a = data.artifact;
  const author = agents.find((x) => x.id === a.agentId);
  const run = runs.find((r) => r.id === a.runId);
  return (
    <div className="panel viewer">
      {onBack && (
        <button type="button" className="back" onClick={onBack}>
          <Icon name="back" /> Archive
        </button>
      )}
      <p className="eyebrow">
        {a.isFinal ? 'Final deliverable' : a.kind} · v{a.version} · {ago(a.createdAt)}
        {a.demo && <span className="sim-badge">simulated</span>}
      </p>
      <h2>{a.name}</h2>
      <p className="muted small">
        {author && (
          <>
            <img className="inline-face" src={face(author)} alt="" /> {author.name} ·{' '}
          </>
        )}
        {run && <>mission “{clip(run.goal, 50)}” · </>}
        <span className="mono">workspace/{a.path}</span>
      </p>
      <div className="row">
        <a className="btn" href={`/api/artifacts/${a.id}/download`} download>
          <Icon name="download" /> Download
        </a>
        <button type="button" className="btn ghost" onClick={() => void navigator.clipboard.writeText(data.content)}>
          Copy
        </button>
      </div>
      <ArtifactBody artifact={a} content={data.content} />
    </div>
  );
}

function Memory() {
  const memories = useStore((s) => s.memories);
  const agents = useStore((s) => s.agents);
  const notify = useStore((s) => s.notify);
  const [q, setQ] = useState('');
  const [note, setNote] = useState('');
  const shown = useMemo(() => {
    const t = q.toLowerCase();
    return memories.filter((m) => !t || m.content.toLowerCase().includes(t) || m.tags.toLowerCase().includes(t)).sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.createdAt - a.createdAt);
  }, [memories, q]);
  const run = (p: Promise<unknown>) => p.catch((e) => notify(errorMessage(e), 'error'));
  return (
    <section className="memory">
      <div className="section-head">
        <h3>Shared memory</h3>
        <span className="muted small">{plural(memories.length, 'note')}</span>
      </div>
      <p className="muted small">Agents search this before and during work. Pinned notes go into every brief.</p>
      <form
        className="free"
        onSubmit={(e) => {
          e.preventDefault();
          if (note.trim().length < 2) return;
          void run(api.post('/api/memories', { content: note.trim(), pinned: true }));
          setNote('');
        }}
      >
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Tell the crew something to always remember…" />
        <button type="submit" className="icon-btn" aria-label="Add note">
          <Icon name="plus" />
        </button>
      </form>
      {memories.length > 0 && <input className="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search memory" />}
      {!memories.length && (
        <div className="empty-state">
          <b>No notes yet</b>
          <span>The crew saves findings and decisions here as they work. Anything you add is pinned into every brief.</span>
        </div>
      )}
      <ul className="mem-list">
        {shown.slice(0, 120).map((m) => {
          const a = agents.find((x) => x.id === m.agentId);
          return (
            <li key={m.id} className={cx(m.pinned && 'pinned', m.scope === 'agent' && 'personal')}>
              <p>{m.content}</p>
              <span className="small muted">
                {a ? a.name : m.source} · {m.scope === 'agent' ? 'personal' : 'shared'} · {ago(m.createdAt)}
                {m.demo && <span className="sim-badge">simulated</span>}
              </span>
              <span className="mem-actions">
                <button type="button" className={cx('icon-btn', m.pinned && 'on')} title={m.pinned ? 'Unpin' : 'Pin: include in every brief'} onClick={() => void run(api.patch(`/api/memories/${m.id}`, { pinned: !m.pinned }))}>
                  <Icon name="pin" size={15} />
                </button>
                <button type="button" className="icon-btn" title="Forget" onClick={() => void run(api.del(`/api/memories/${m.id}`))}>
                  <Icon name="trash" size={15} />
                </button>
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Charter() {
  const charter = useStore((s) => s.charter);
  const notify = useStore((s) => s.notify);
  const [text, setText] = useState(charter);
  useEffect(() => setText(charter), [charter]);
  return (
    <section>
      <div className="section-head">
        <h3>Project charter</h3>
        <span className="muted small">in every agent's instructions</span>
      </div>
      <textarea rows={5} value={text} onChange={(e) => setText(e.target.value)} placeholder="Who you are, what you're working on, standards, constraints. Say it once here instead of in every goal." />
      <button
        type="button"
        className="btn"
        disabled={text === charter}
        onClick={() =>
          api
            .put('/api/charter', { text })
            .then(() => notify('Charter saved. It applies from the next model call.'))
            .catch((e) => notify(errorMessage(e), 'error'))
        }
      >
        Save charter
      </button>
    </section>
  );
}

export function ArchivePanel() {
  const artifacts = useStore((s) => s.artifacts);
  const runs = useStore((s) => s.runs);
  const run = useStore((s) => s.run);
  const agents = useStore((s) => s.agents);
  const open = useStore((s) => s.openArtifact);
  const showArtifact = useStore((s) => s.showArtifact);

  if (open) return <ArtifactViewer id={open} onBack={() => showArtifact(null)} />;

  const groups = new Map<string, Artifact[]>();
  for (const a of artifacts) {
    const k = a.runId ?? 'none';
    groups.set(k, [...(groups.get(k) ?? []), a]);
  }
  const startedAt = (id: string) => runs.find((r) => r.id === id)?.createdAt ?? 0;
  // The current mission first, then newest to oldest.
  const order = [...groups.entries()].sort(([a], [b]) => (a === run?.id ? -1 : b === run?.id ? 1 : startedAt(b) - startedAt(a)));

  return (
    <div className="panel archive">
      <h2>Archive</h2>
      <p className="muted small">Everything is also on disk under <span className="mono">workspace/</span>, one folder per mission.</p>
      {!artifacts.length && (
        <div className="empty-state">
          <b>Nothing filed yet</b>
          <span>Every document, table and piece of code the crew writes lands here as the mission runs.</span>
        </div>
      )}
      {order.map(([rid, files]) => {
        const r = runs.find((x) => x.id === rid);
        const list = files.sort((a, b) => Number(b.isFinal) - Number(a.isFinal) || a.createdAt - b.createdAt);
        return (
          <section key={rid}>
            <h3 className="group-title">{r ? clip(r.goal, 70) : 'Unfiled'}{rid === run?.id && <span className="tag">current</span>}</h3>
            <ul className="file-list">
              {list.map((a) => {
                const au = agents.find((x) => x.id === a.agentId);
                return (
                  <li key={a.id}>
                    <button type="button" className={cx(a.isFinal && 'final')} onClick={() => showArtifact(a.id)}>
                      {au ? <img className="inline-face" src={face(au)} alt="" /> : <Icon name="doc" />}
                      <span className="grow">{a.name}</span>
                      {a.demo && <span className="sim-badge">sim</span>}
                      <span className="muted small">v{a.version}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
      <Memory />
      <Charter />
    </div>
  );
}
