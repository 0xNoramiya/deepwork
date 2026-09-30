import { useState } from 'react';
import { api, errorMessage } from '../api.ts';
import { openRequests, useStore } from '../store.ts';
import { clip, cx, money, RUN_LABEL, tokens } from '../util.ts';
import { Icon } from '../icons.tsx';

const TELEGRAPH = [
  { key: 'stop', label: 'All stop', n: 0, hint: 'Pause everything after the current step' },
  { key: 'slow', label: 'Slow', n: 1, hint: 'One agent at a time' },
  { key: 'half', label: 'Half', n: 3, hint: 'Up to three agents in parallel' },
  { key: 'full', label: 'Full', n: 5, hint: 'Up to five agents in parallel' },
] as const;

export function TopBar() {
  const run = useStore((s) => s.run);
  const requests = useStore((s) => s.requests);
  const connected = useStore((s) => s.connected);
  const set = useStore((s) => s.set);
  const notify = useStore((s) => s.notify);
  const [busy, setBusy] = useState(false);

  const active = run && !['completed', 'failed', 'cancelled'].includes(run.status);
  const open = openRequests(requests).length;
  const paused = run?.status === 'paused';
  const current = !active ? null : paused ? 'stop' : run.limits.concurrency <= 1 ? 'slow' : run.limits.concurrency <= 3 ? 'half' : 'full';
  const spentPct = run ? Math.min(1, run.spentUsd / run.limits.budgetUsd) : 0;

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      notify(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const telegraph = (n: number) =>
    act(async () => {
      if (!run) return;
      if (n === 0) return api.post(`/api/runs/${run.id}/pause`);
      await api.patch(`/api/runs/${run.id}/limits`, { concurrency: n });
      if (paused) await api.post(`/api/runs/${run.id}/resume`);
    });

  return (
    <header className="topbar">
      <div className="brand">
        <Icon name="sub" />
        <span>Deepwork</span>
      </div>

      <div className="mission-chip" title={run?.goal}>
        {run ? (
          <>
            <span className={cx('status-dot', `s-${run.status}`)} />
            <span className="mission-status">{RUN_LABEL[run.status]}</span>
            <span className="mission-goal">{clip(run.goal, 70)}</span>
          </>
        ) : (
          <span className="mission-goal muted">No mission yet</span>
        )}
      </div>

      <div className="topbar-right">
        {run && (
          <div className="gauge" title={`${money(run.spentUsd)} of ${money(run.limits.budgetUsd)} · ${tokens(run.tokensIn)} in / ${tokens(run.tokensOut)} out${run.demo ? ' · simulated steps cost nothing' : ''}`}>
            <span className="gauge-label">Budget</span>
            <span className="gauge-bar">
              <span className={cx(spentPct > 0.8 && 'hot')} style={{ width: `${spentPct * 100}%` }} />
            </span>
            <span className="gauge-num">
              {money(run.spentUsd)} <em>/ {money(run.limits.budgetUsd)}</em>
            </span>
          </div>
        )}

        <div className={cx('telegraph', !active && 'disabled')} role="group" aria-label="Engine order telegraph: how many agents work at once">
          {TELEGRAPH.map((t) => (
            <button key={t.key} type="button" disabled={!active || busy || run?.status === 'review' || run?.status === 'planning'} className={cx(current === t.key && 'on', t.key === 'stop' && 'stop')} title={t.hint} onClick={() => void telegraph(t.n)}>
              {t.label}
            </button>
          ))}
        </div>

        {active && (
          <button
            type="button"
            className="icon-btn danger"
            title="Cancel the mission"
            onClick={() => {
              if (confirm('Cancel this mission? Work in progress stops immediately. Files already written are kept.')) void act(() => api.post(`/api/runs/${run.id}/cancel`));
            }}
          >
            <Icon name="x" />
          </button>
        )}

        <button type="button" className={cx('icon-btn bell', open > 0 && 'ringing')} title={open ? `${open} decision${open > 1 ? 's' : ''} waiting` : 'No decisions waiting'} onClick={() => set({ tab: 'mission', selectedTask: null })}>
          <Icon key={open} name="bell" />
          {open > 0 && <b>{open}</b>}
        </button>
        <button type="button" className="icon-btn" title="Models, keys and defaults" onClick={() => set({ settingsOpen: true })}>
          <Icon name="gear" />
        </button>
        {!connected && <span className="offline" title="Lost the connection to the server; retrying">reconnecting…</span>}
      </div>
    </header>
  );
}
