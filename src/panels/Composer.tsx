import { useState } from 'react';
import { api, errorMessage } from '../api.ts';
import { useStore } from '../store.ts';
import { face } from '../util.ts';

const EXAMPLES = [
  'Compare three open-source note-taking apps for a five-person team and recommend one, with a migration checklist.',
  'Write a Python CLI that deduplicates photos in a folder by perceptual hash, with a README and tests.',
  'Draft a friendly launch announcement for a small bakery’s new sourdough subscription, plus three social posts.',
  'Plan a two-day offsite for a remote team of 12: agenda, budget table, and a pre-read.',
];

export function Composer({ onStarted }: { onStarted?: () => void }) {
  const defaults = useStore((s) => s.defaults);
  const agents = useStore((s) => s.agents);
  const providers = useStore((s) => s.providers);
  const set = useStore((s) => s.set);
  const notify = useStore((s) => s.notify);
  const [goal, setGoal] = useState('');
  const [budget, setBudget] = useState(String(defaults.budgetUsd));
  const [concurrency, setConcurrency] = useState(defaults.concurrency);
  const [review, setReview] = useState(defaults.requirePlanApproval);
  const [steps, setSteps] = useState(defaults.maxStepsPerTask);
  const [sending, setSending] = useState(false);

  const crew = agents.filter((a) => a.enabled);
  const onDemo = crew.filter((a) => a.providerId === 'demo');
  const unassigned = crew.filter((a) => !a.providerId || !a.model);
  const realProviders = providers.filter((p) => p.kind !== 'demo' && p.keySource !== 'none');

  const dive = async () => {
    if (goal.trim().length < 3) return;
    setSending(true);
    try {
      await api.post('/api/runs', {
        goal: goal.trim(),
        limits: { budgetUsd: Math.max(0.05, Number(budget) || defaults.budgetUsd), concurrency, requirePlanApproval: review, maxStepsPerTask: steps },
      });
      setGoal('');
      onStarted?.();
    } catch (e) {
      notify(errorMessage(e), 'error');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="panel composer">
      <h2>What should the crew do?</h2>
      <p className="muted">Give a goal, not a to-do list. The lead splits it up, the crew works in parallel where they can, and you get the result in the archive.</p>
      <textarea
        value={goal}
        onChange={(e) => setGoal(e.target.value)}
        placeholder="e.g. Research the three best options for… and write a one-page recommendation"
        rows={5}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void dive();
        }}
        autoFocus
      />
      <div className="examples">
        <span className="muted small">For example</span>
        {EXAMPLES.map((ex) => (
          <button key={ex} type="button" className="chip" onClick={() => setGoal(ex)}>
            {ex}
          </button>
        ))}
      </div>

      <div className="limits">
        <label>
          <span>Budget</span>
          <span className="money-input">
            $<input type="number" min="0.05" step="0.5" value={budget} onChange={(e) => setBudget(e.target.value)} />
          </span>
        </label>
        <label>
          <span>At once</span>
          <select value={concurrency} onChange={(e) => setConcurrency(Number(e.target.value))}>
            {[1, 2, 3, 4, 5].map((n) => (
              <option key={n} value={n}>
                {n} agent{n > 1 ? 's' : ''}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Steps per task</span>
          <input type="number" min="3" max="60" value={steps} onChange={(e) => setSteps(Number(e.target.value))} />
        </label>
        <label className="check">
          <input type="checkbox" checked={review} onChange={(e) => setReview(e.target.checked)} />
          <span>Let me review the plan first</span>
        </label>
      </div>

      <div className="readiness">
        <div className="faces">
          {crew.map((a) => (
            <img key={a.id} src={face(a)} alt={a.name} title={`${a.name} · ${a.title} · ${a.providerId === 'demo' ? 'demo (simulated)' : a.model}`} className={a.providerId === 'demo' ? 'sim' : ''} />
          ))}
        </div>
        {onDemo.length === crew.length ? (
          <p>
            <b>Demo mode.</b> No model is connected, so the crew's words are simulated. Planning, parallel work, approvals, questions and files are all real.{' '}
            <button type="button" className="link" onClick={() => set({ settingsOpen: true })}>
              {realProviders.length ? 'Assign a model' : 'Connect a model'}
            </button>
          </p>
        ) : onDemo.length ? (
          <p>
            {onDemo.map((a) => a.name).join(', ')} {onDemo.length > 1 ? 'are' : 'is'} on the demo provider and will produce simulated output.
          </p>
        ) : (
          <p>{crew.length} crew ready.</p>
        )}
        {unassigned.length > 0 && <p className="warn-text">{unassigned.map((a) => a.name).join(', ')} {unassigned.length > 1 ? 'have' : 'has'} no model and can't take tasks.</p>}
      </div>

      <button type="button" className="btn primary big" disabled={sending || goal.trim().length < 3} onClick={() => void dive()} title="⌘/Ctrl + Enter">
        {sending ? 'Diving…' : 'Dive'}
      </button>
    </div>
  );
}
