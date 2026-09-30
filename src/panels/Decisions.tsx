import { useState } from 'react';
import type { DecisionRequest } from '../../shared/types.ts';
import { api, errorMessage } from '../api.ts';
import { Icon } from '../icons.tsx';
import { useStore } from '../store.ts';
import { ago, face } from '../util.ts';

const KIND_LABEL: Record<DecisionRequest['kind'], string> = {
  question: 'Question',
  approval: 'Approval',
  plan: 'Plan',
  budget: 'Budget',
  blocked: 'Stuck',
};

function Args({ q }: { q: DecisionRequest }) {
  if (!q.args) return null;
  const a = q.args;
  if (q.tool === 'web_fetch') {
    return (
      <div className="call">
        <span className="call-tool">GET</span>
        <code className="url">{String(a.url)}</code>
      </div>
    );
  }
  return (
    <div className="call">
      <span className="call-tool">{String(a.method ?? q.tool)}</span>
      <code className="url">{String(a.url ?? '')}</code>
      {a.body ? <pre>{String(a.body).slice(0, 1200)}</pre> : null}
      {a.headers && Object.keys(a.headers as object).length ? <pre>{JSON.stringify(a.headers, null, 2)}</pre> : null}
    </div>
  );
}

function Card({ q }: { q: DecisionRequest }) {
  const agents = useStore((s) => s.agents);
  const notify = useStore((s) => s.notify);
  const selectTask = useStore((s) => s.selectTask);
  const [text, setText] = useState('');
  const [always, setAlways] = useState(false);
  const [busy, setBusy] = useState(false);
  const agent = agents.find((a) => a.id === q.agentId);

  const answer = async (response: string) => {
    setBusy(true);
    try {
      if (always && q.tool === 'web_fetch' && agent && /^approve/i.test(response)) {
        await api.patch(`/api/agents/${agent.id}`, { autoApprove: [...new Set([...agent.autoApprove, 'web_fetch'])] });
      }
      await api.post(`/api/requests/${q.id}/resolve`, { response });
    } catch (e) {
      notify(errorMessage(e), 'error');
      setBusy(false);
    }
  };

  const freeText = q.kind === 'question' || q.kind === 'blocked' || q.kind === 'approval';
  const placeholder = q.kind === 'approval' ? 'Deny with a reason (optional)…' : q.kind === 'blocked' ? 'Retry with guidance…' : 'Or write your own answer…';

  return (
    <article className={`decision k-${q.kind}`}>
      <header>
        {agent ? <img src={face(agent)} alt="" /> : <span className="sys-face"><Icon name={q.kind === 'budget' ? 'lock' : 'sub'} /></span>}
        <div>
          <p className="eyebrow">
            <span className="stamp">{KIND_LABEL[q.kind]}</span>
            <span>
              {agent ? `${agent.name} · ` : ''}
              {ago(q.createdAt)}
            </span>
          </p>
          <h4>{q.title}</h4>
        </div>
      </header>
      {q.body && q.kind !== 'plan' && <p className="why">{q.body}</p>}
      <Args q={q} />
      {q.risk && (
        <p className="risk">{q.risk}</p>
      )}
      {q.tool === 'web_fetch' && agent && (
        <label className="check small">
          <input type="checkbox" checked={always} onChange={(e) => setAlways(e.target.checked)} />
          <span>Let {agent.name} read web pages without asking from now on</span>
        </label>
      )}
      <div className="options">
        {q.options.map((o) => (
          <button key={o} type="button" disabled={busy} className={/^(approve|launch|retry|add)/i.test(o) ? 'btn primary' : /^(deny|cancel)/i.test(o) ? 'btn danger-ghost' : 'btn'} onClick={() => void answer(o)}>
            {o}
          </button>
        ))}
      </div>
      {freeText && (
        <form
          className="free"
          onSubmit={(e) => {
            e.preventDefault();
            if (!text.trim()) return;
            void answer(q.kind === 'approval' ? `Deny: ${text.trim()}` : text.trim());
          }}
        >
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder} />
          <button type="submit" className="icon-btn" disabled={busy || !text.trim()} aria-label="Send">
            <Icon name="send" />
          </button>
        </form>
      )}
      {q.taskId && q.kind === 'blocked' && (
        <button type="button" className="link small" onClick={() => selectTask(q.taskId)}>
          See what happened
        </button>
      )}
    </article>
  );
}

export function Decisions({ requests }: { requests: DecisionRequest[] }) {
  const order = { approval: 0, question: 1, blocked: 2, budget: 3, plan: 4 };
  const sorted = [...requests].sort((a, b) => order[a.kind] - order[b.kind] || a.createdAt - b.createdAt);
  return (
    <section className="decisions">
      <h3>Waiting on you</h3>
      {sorted.map((q) => (
        <Card key={q.id} q={q} />
      ))}
    </section>
  );
}
