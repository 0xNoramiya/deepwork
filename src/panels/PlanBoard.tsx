import { useLayoutEffect, useRef, useState } from 'react';
import type { Task } from '../../shared/types.ts';
import { api, errorMessage } from '../api.ts';
import { useStore } from '../store.ts';
import { cx, face, money, TASK_LABEL } from '../util.ts';

function levels(tasks: Task[]): Task[][] {
  const memo = new Map<string, number>();
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const depth = (t: Task, seen = new Set<string>()): number => {
    const known = memo.get(t.id);
    if (known !== undefined) return known;
    if (seen.has(t.id)) return 0;
    seen.add(t.id);
    const deps = t.dependsOn.map((d) => byId.get(d)).filter((d): d is Task => !!d);
    const v = deps.length ? 1 + Math.max(...deps.map((d) => depth(d, seen))) : 0;
    memo.set(t.id, v);
    return v;
  };
  const rows: Task[][] = [];
  for (const t of tasks) (rows[depth(t)] ??= []).push(t);
  return rows.filter(Boolean);
}

function Editor({ task, onClose }: { task: Task; onClose: () => void }) {
  const agents = useStore((s) => s.agents);
  const tasks = useStore((s) => s.tasks);
  const notify = useStore((s) => s.notify);
  const [draft, setDraft] = useState({ title: task.title, description: task.description, acceptance: task.acceptance, assigneeId: task.assigneeId, dependsOn: task.dependsOn });
  const save = async () => {
    try {
      await api.patch(`/api/tasks/${task.id}`, draft);
      onClose();
    } catch (e) {
      notify(errorMessage(e), 'error');
    }
  };
  const remove = async () => {
    try {
      await api.del(`/api/tasks/${task.id}`);
      onClose();
    } catch (e) {
      notify(errorMessage(e), 'error');
    }
  };
  return (
    <div className="task-editor">
      <label>
        <span>Title</span>
        <input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
      </label>
      <label>
        <span>Owner</span>
        <select value={draft.assigneeId} onChange={(e) => setDraft({ ...draft, assigneeId: e.target.value })}>
          {agents
            .filter((a) => a.enabled)
            .map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} · {a.title}
              </option>
            ))}
        </select>
      </label>
      <label>
        <span>What to do</span>
        <textarea rows={4} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
      </label>
      <label>
        <span>Done when</span>
        <textarea rows={2} value={draft.acceptance} onChange={(e) => setDraft({ ...draft, acceptance: e.target.value })} />
      </label>
      <fieldset>
        <legend>Waits for</legend>
        {tasks
          .filter((t) => t.id !== task.id)
          .map((t) => (
            <label key={t.id} className="check small">
              <input
                type="checkbox"
                checked={draft.dependsOn.includes(t.id)}
                onChange={(e) => setDraft({ ...draft, dependsOn: e.target.checked ? [...draft.dependsOn, t.id] : draft.dependsOn.filter((d) => d !== t.id) })}
              />
              <span>{t.title}</span>
            </label>
          ))}
      </fieldset>
      <div className="row">
        <button type="button" className="btn primary" onClick={() => void save()}>
          Save
        </button>
        <button type="button" className="btn ghost" onClick={onClose}>
          Close
        </button>
        <span className="grow" />
        <button type="button" className="btn danger-ghost" onClick={() => void remove()}>
          Remove
        </button>
      </div>
    </div>
  );
}

export function PlanBoard({ editable }: { editable: boolean }) {
  const tasks = useStore((s) => s.tasks);
  const agents = useStore((s) => s.agents);
  const live = useStore((s) => s.live);
  const selectTask = useStore((s) => s.selectTask);
  const [editing, setEditing] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const cards = useRef(new Map<string, HTMLElement>());
  const [edges, setEdges] = useState<{ d: string; on: boolean; key: string }[]>([]);

  const rows = levels(tasks);

  useLayoutEffect(() => {
    const root = box.current;
    if (!root) return;
    const draw = () => {
      const r0 = root.getBoundingClientRect();
      const out: { d: string; on: boolean; key: string }[] = [];
      for (const t of tasks) {
        const to = cards.current.get(t.id)?.getBoundingClientRect();
        if (!to) continue;
        for (const d of t.dependsOn) {
          const from = cards.current.get(d)?.getBoundingClientRect();
          if (!from) continue;
          const x1 = from.left + from.width / 2 - r0.left;
          const y1 = from.bottom - r0.top;
          const x2 = to.left + to.width / 2 - r0.left;
          const y2 = to.top - r0.top;
          const my = (y1 + y2) / 2;
          const dep = tasks.find((x) => x.id === d);
          out.push({ key: `${d}-${t.id}`, d: `M ${x1} ${y1} C ${x1} ${my}, ${x2} ${my}, ${x2} ${y2}`, on: dep?.status === 'done' || dep?.status === 'skipped' });
        }
      }
      setEdges(out);
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(root);
    return () => ro.disconnect();
  }, [tasks, editing]);

  return (
    <div className="board" ref={box}>
      <svg className="board-edges" aria-hidden>
        {edges.map((e) => (
          <path key={e.key} d={e.d} className={e.on ? 'on' : ''} />
        ))}
      </svg>
      {rows.map((row, i) => (
        <div className="board-row" key={i}>
          {row.map((t) => {
            const a = agents.find((x) => x.id === t.assigneeId);
            const l = a ? live[a.id] : undefined;
            const isEditing = editing === t.id;
            return (
              <div
                key={t.id}
                ref={(el) => {
                  if (el) cards.current.set(t.id, el);
                  else cards.current.delete(t.id);
                }}
                className={cx('task-card', `st-${t.status}`, isEditing && 'editing')}
              >
                {isEditing ? (
                  <Editor task={t} onClose={() => setEditing(null)} />
                ) : (
                  <button type="button" className="task-card-btn" onClick={() => (editable ? setEditing(t.id) : selectTask(t.id))}>
                    <span className="task-top">
                      {a && <img src={face(a)} alt={a.name} />}
                      <span className="task-owner">{a?.name ?? '?'}</span>
                      <span className="task-status">{TASK_LABEL[t.status]}</span>
                    </span>
                    <span className="task-title">{t.title}</span>
                    {t.status === 'running' && l?.detail && <span className="task-live">{l.detail}</span>}
                    {!editable && (t.steps > 0 || t.spentUsd > 0) && (
                      <span className="task-meta">
                        {t.steps} steps · {money(t.spentUsd)}
                        {t.artifactIds.length > 0 && ` · ${t.artifactIds.length} file${t.artifactIds.length > 1 ? 's' : ''}`}
                      </span>
                    )}
                    {editable && <span className="task-meta">{t.description.slice(0, 110)}{t.description.length > 110 ? '…' : ''}</span>}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
