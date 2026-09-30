import { useEffect, useState } from 'react';
import type { Task } from '../../shared/types.ts';
import { api, errorMessage } from '../api.ts';
import { Icon } from '../icons.tsx';
import { useStore } from '../store.ts';
import { ago, cx, face, money, TASK_LABEL } from '../util.ts';

interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}
type Msg =
  | { role: 'user'; content: string; toolResults?: { id: string; name: string; content: string; isError?: boolean }[] }
  | { role: 'assistant'; text: string; toolCalls: ToolCall[]; thinking: string; demo: boolean };

export function Transcript({ owner }: { owner: string }) {
  const [msgs, setMsgs] = useState<Msg[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const events = useStore((s) => s.events.length);
  useEffect(() => {
    api
      .get<Msg[]>(`/api/transcripts/${encodeURIComponent(owner)}`)
      .then(setMsgs)
      .catch((e) => setErr(errorMessage(e)));
  }, [owner, events]);
  if (err) return <p className="warn-text">{err}</p>;
  if (!msgs) return <p className="muted small">Loading…</p>;
  if (!msgs.length) return <p className="muted small">Nothing yet.</p>;
  return (
    <ol className="transcript">
      {msgs.map((m, i) =>
        m.role === 'user' ? (
          <li key={i} className="t-user">
            {m.toolResults?.map((r) => (
              <details key={r.id} className={cx('t-result', r.isError && 'err')}>
                <summary>
                  ↳ {r.name} {r.isError ? 'error' : 'result'} <span className="muted">({r.content.length} chars)</span>
                </summary>
                <pre>{r.content.slice(0, 6000)}</pre>
              </details>
            ))}
            {m.content && (
              <details open={i === 0}>
                <summary>{i === 0 ? 'Brief given to the agent' : 'Message to the agent'}</summary>
                <pre>{m.content}</pre>
              </details>
            )}
          </li>
        ) : (
          <li key={i} className="t-assistant">
            {m.demo && <span className="sim-badge">simulated step</span>}
            {m.thinking && (
              <details className="t-thinking">
                <summary>Reasoning summary</summary>
                <pre>{m.thinking}</pre>
              </details>
            )}
            {m.text && <p className="t-text">{m.text}</p>}
            {m.toolCalls.map((c) => (
              <details key={c.id} className="t-call">
                <summary>
                  <code>{c.name}</code>
                </summary>
                <pre>{JSON.stringify(c.args, null, 2).slice(0, 6000)}</pre>
              </details>
            ))}
          </li>
        ),
      )}
    </ol>
  );
}

export function TaskDetail({ taskId }: { taskId: string }) {
  const task = useStore((s) => s.tasks.find((t) => t.id === taskId));
  return task ? <TaskView task={task} /> : null;
}

function TaskView({ task }: { task: Task }) {
  const tasks = useStore((s) => s.tasks);
  const agents = useStore((s) => s.agents);
  const artifacts = useStore((s) => s.artifacts);
  const selectTask = useStore((s) => s.selectTask);
  const selectAgent = useStore((s) => s.selectAgent);
  const showArtifact = useStore((s) => s.showArtifact);
  const notify = useStore((s) => s.notify);
  const [note, setNote] = useState('');
  const agent = agents.find((a) => a.id === task.assigneeId);
  const deps = tasks.filter((t) => task.dependsOn.includes(t.id));
  const arts = task.artifactIds.flatMap((id) => artifacts.filter((a) => a.id === id));

  const act = (path: string, body: unknown = {}) => api.post(`/api/tasks/${task.id}/${path}`, body).catch((e) => notify(errorMessage(e), 'error'));
  const running = ['running', 'waiting_user', 'waiting_approval'].includes(task.status);
  const stuck = ['blocked', 'failed', 'skipped', 'cancelled'].includes(task.status);

  return (
    <div className="panel task-detail">
      <button type="button" className="back" onClick={() => selectTask(null)}>
        <Icon name="back" /> Plan
      </button>
      <p className="eyebrow">
        <span className={cx('pill', `st-${task.status}`)}>{TASK_LABEL[task.status]}</span>
        {task.startedAt && ` · started ${ago(task.startedAt)}`}
      </p>
      <h2>{task.title}</h2>
      {agent && (
        <button type="button" className="owner" onClick={() => selectAgent(agent.id)}>
          <img src={face(agent)} alt="" /> {agent.name} · {agent.title}
        </button>
      )}
      <p className="desc">{task.description}</p>
      {task.acceptance && (
        <p className="acceptance">
          <b>Done when:</b> {task.acceptance}
        </p>
      )}
      {deps.length > 0 && (
        <p className="muted small">
          Waits for:{' '}
          {deps.map((d, i) => (
            <span key={d.id}>
              {i > 0 && ', '}
              <button type="button" className="link" onClick={() => selectTask(d.id)}>
                {d.title}
              </button>
            </span>
          ))}
        </p>
      )}
      {task.error && <div className="callout error">{task.error}</div>}
      {task.resultSummary && (
        <section>
          <h3>Result</h3>
          <p>{task.resultSummary}</p>
          {task.notesForTeam && (
            <p className="muted">
              <b>Notes for the team:</b> {task.notesForTeam}
            </p>
          )}
        </section>
      )}
      {arts.length > 0 && (
        <section>
          <h3>Files</h3>
          <ul className="file-list">
            {arts.map((a) => (
              <li key={a.id}>
                <button type="button" onClick={() => showArtifact(a.id)}>
                  {a.name}
                  {a.demo && <span className="sim-badge">simulated</span>}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <p className="mission-line">
        {task.steps} steps · {money(task.spentUsd)} · {task.consults} teammate question{task.consults === 1 ? '' : 's'} · attempt {task.attempts + 1}
      </p>

      <div className="row">
        {running && (
          <button type="button" className="btn" onClick={() => void act('stop')}>
            Stop
          </button>
        )}
        {(task.status === 'pending' || running || stuck) && task.status !== 'skipped' && (
          <button type="button" className="btn ghost" onClick={() => void act('skip')}>
            Skip
          </button>
        )}
      </div>
      {stuck && (
        <form
          className="free"
          onSubmit={(e) => {
            e.preventDefault();
            void act('retry', { note: note.trim() || undefined });
            setNote('');
          }}
        >
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Retry, optionally with guidance…" />
          <button type="submit" className="btn primary">
            Retry
          </button>
        </form>
      )}

      <details className="work">
        <summary>
          Show the work: every model step and tool call
        </summary>
        <Transcript owner={task.id} />
      </details>
    </div>
  );
}
