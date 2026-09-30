import { useState } from 'react';
import { api, errorMessage } from '../api.ts';
import { openRequests, useStore } from '../store.ts';
import { ago, cx, money, RUN_LABEL, tokens } from '../util.ts';
import { Composer } from './Composer.tsx';
import { Decisions } from './Decisions.tsx';
import { PlanBoard } from './PlanBoard.tsx';
import { TaskDetail } from './TaskDetail.tsx';

export function MissionPanel() {
  const run = useStore((s) => s.run);
  const tasks = useStore((s) => s.tasks);
  const requests = useStore((s) => s.requests);
  const selectedTask = useStore((s) => s.selectedTask);
  const set = useStore((s) => s.set);
  const notify = useStore((s) => s.notify);
  const showArtifact = useStore((s) => s.showArtifact);
  const [composing, setComposing] = useState(false);

  const active = run && !['completed', 'failed', 'cancelled'].includes(run.status);
  const open = openRequests(requests);

  if (!run || (composing && !active)) return <Composer onStarted={() => setComposing(false)} />;
  if (selectedTask && tasks.some((t) => t.id === selectedTask)) return <TaskDetail taskId={selectedTask} />;

  const done = tasks.filter((t) => t.status === 'done').length;
  const act = (path: string) => api.post(`/api/runs/${run.id}/${path}`).catch((e) => notify(errorMessage(e), 'error'));

  return (
    <div className="panel mission">
      <section className="mission-head">
        <p className="eyebrow">
          <span className={cx('status-dot', `s-${run.status}`)} /> {RUN_LABEL[run.status]} · started {ago(run.createdAt)}
          {run.demo && <span className="sim-badge" title="Some or all steps were produced by the demo provider, not a model">simulated</span>}
        </p>
        <h2 className="goal">{run.goal}</h2>
        <p className="mission-line">
          {tasks.length ? `${done} of ${tasks.length} tasks` : 'no plan yet'} · {money(run.spentUsd)} of {money(run.limits.budgetUsd)} · {tokens(run.tokensIn + run.tokensOut)} tokens
        </p>
        {run.status === 'paused' && (
          <div className="callout warn">
            <p>{run.pauseReason ?? 'Paused.'}</p>
            <button type="button" className="btn" onClick={() => void act('resume')}>
              Resume
            </button>
          </div>
        )}
        {run.status === 'failed' && <div className="callout error">{run.error}</div>}
        {run.status === 'planning' && <p className="muted small">The lead is breaking the goal into tasks. {run.limits.requirePlanApproval ? "You'll see the plan before anyone starts." : 'Plan review is off, so work starts as soon as the plan is ready.'}</p>}
      </section>

      {open.length > 0 && <Decisions requests={open} />}

      {run.status === 'completed' && (
        <section className="haul-card">
          <h3>The haul</h3>
          <p>{run.summary}</p>
          <div className="row">
            {run.finalArtifactId && (
              <button type="button" className="btn primary" onClick={() => showArtifact(run.finalArtifactId)}>
                Open the final report
              </button>
            )}
            <button type="button" className="btn" onClick={() => set({ haulOpen: true })}>
              Summary
            </button>
          </div>
        </section>
      )}

      {tasks.length > 0 && (
        <section>
          <div className="section-head">
            <h3>{run.status === 'review' ? 'Proposed plan' : 'Plan'}</h3>
            {run.status === 'review' && <span className="muted small">Edit anything, then launch.</span>}
          </div>
          {run.planRationale && <p className="rationale">{run.planRationale}</p>}
          <PlanBoard editable={run.status === 'review'} />
          {run.status === 'review' && (
            <div className="row launch-row">
              <button type="button" className="btn primary big" onClick={() => void act('launch')}>
                Launch the crew
              </button>
              <button type="button" className="btn ghost" onClick={() => confirm('Discard this plan and cancel the mission?') && void act('cancel')}>
                Cancel
              </button>
            </div>
          )}
        </section>
      )}

      {!active && (
        <button type="button" className="btn primary big new-mission" onClick={() => setComposing(true)}>
          New mission
        </button>
      )}
    </div>
  );
}
