import { useState } from 'react';
import type { ProviderPublic } from '../../shared/types.ts';
import { api, errorMessage } from '../api.ts';
import { Icon } from '../icons.tsx';
import { useStore } from '../store.ts';
import { cx } from '../util.ts';

function ProviderRow({ p }: { p: ProviderPublic }) {
  const agents = useStore((s) => s.agents);
  const notify = useStore((s) => s.notify);
  const [test, setTest] = useState<{ ok: boolean; models?: string[]; error?: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [model, setModel] = useState(p.defaultModel);
  const [key, setKey] = useState('');
  const users = agents.filter((a) => a.providerId === p.id);
  const local = /localhost|127\.0\.0\.1/.test(p.baseUrl ?? '');
  const ready = p.kind === 'demo' || p.keySource !== 'none' || local;

  const runTest = async () => {
    setTesting(true);
    try {
      setTest(await api.post(`/api/providers/${p.id}/test`));
    } catch (e) {
      setTest({ ok: false, error: errorMessage(e) });
    } finally {
      setTesting(false);
    }
  };
  const assign = async () => {
    try {
      await api.post(`/api/providers/${p.id}/assign`, { model: p.kind === 'demo' ? 'simulated' : model });
      notify(`Whole crew now on ${p.label}${p.kind === 'demo' ? '' : ` · ${model}`}.`);
    } catch (e) {
      notify(errorMessage(e), 'error');
    }
  };
  const saveKey = async () => {
    try {
      await api.patch(`/api/providers/${p.id}`, { apiKey: key, defaultModel: model });
      setKey('');
      notify('Key saved (encrypted on this machine).');
    } catch (e) {
      notify(errorMessage(e), 'error');
    }
  };
  const remove = async () => {
    try {
      await api.del(`/api/providers/${p.id}`);
    } catch (e) {
      notify(errorMessage(e), 'error');
    }
  };

  return (
    <li className={cx('provider', !ready && 'not-ready')}>
      <div className="provider-head">
        <b>{p.label}</b>
        <span className="muted small">
          {p.kind === 'demo'
            ? 'Built in. No model: scripted, clearly labelled output.'
            : p.keySource === 'env'
              ? `Key from $${p.envVar} · ${p.keyHint}`
              : p.keySource === 'stored'
                ? `Key stored encrypted · ${p.keyHint}`
                : local
                  ? `Local server · ${p.baseUrl}`
                  : 'No key yet'}
        </span>
        <span className="muted small">{users.length ? `Used by ${users.map((a) => a.name).join(', ')}` : 'Not used by anyone'}</span>
      </div>
      {p.kind !== 'demo' && (
        <div className="row wrap">
          {p.keySource !== 'env' && (
            <>
              <input type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder={p.keySource === 'stored' ? 'Replace key…' : 'Paste API key…'} />
              <button type="button" className="btn" disabled={!key} onClick={() => void saveKey()}>
                Save key
              </button>
            </>
          )}
          <button type="button" className="btn ghost" disabled={testing || !ready} onClick={() => void runTest()}>
            {testing ? 'Testing…' : 'Test'}
          </button>
          {!users.length && p.keySource !== 'env' && (
            <button type="button" className="icon-btn" title="Remove provider" onClick={() => void remove()}>
              <Icon name="trash" />
            </button>
          )}
        </div>
      )}
      {test && (
        <p className={cx('small', test.ok ? 'ok-text' : 'warn-text')}>
          {test.ok ? `Connected. ${test.models?.length ?? 0} models available.` : test.error}
        </p>
      )}
      {ready && (
        <div className="row wrap">
          {p.kind !== 'demo' && (
            <>
              <input list={`pm-${p.id}`} value={model} onChange={(e) => setModel(e.target.value)} placeholder="model id" />
              <datalist id={`pm-${p.id}`}>
                {test?.models?.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </>
          )}
          <button type="button" className="btn primary" disabled={p.kind !== 'demo' && !model} onClick={() => void assign()}>
            Use for the whole crew
          </button>
        </div>
      )}
    </li>
  );
}

function AddProvider() {
  const presets = useStore((s) => s.presets);
  const notify = useStore((s) => s.notify);
  const [presetId, setPresetId] = useState(presets[0]?.id ?? 'anthropic');
  // The select below only offers ids from this list.
  const preset = presets.find((p) => p.id === presetId)!;
  const [key, setKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [label, setLabel] = useState('');
  const add = async () => {
    try {
      await api.post('/api/providers', {
        kind: preset.kind,
        label: label || preset.label,
        baseUrl: preset.id === 'custom' ? baseUrl : preset.baseUrl,
        apiKey: key || null,
        defaultModel: model || preset.defaultModel,
      });
      setKey('');
      setModel('');
      setLabel('');
      notify('Provider added. Test it, then assign it to the crew.');
    } catch (e) {
      notify(errorMessage(e), 'error');
    }
  };
  return (
    <div className="add-provider">
      <h3>Add a provider</h3>
      <div className="grid2">
        <label>
          <span>Service</span>
          <select value={presetId} onChange={(e) => setPresetId(e.target.value)}>
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Name (optional)</span>
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={preset?.label} />
        </label>
      </div>
      {preset?.id === 'custom' && (
        <label>
          <span>Base URL (OpenAI-compatible)</span>
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://…/v1" />
        </label>
      )}
      <div className="grid2">
        <label>
          <span>API key{preset?.needsKey ? '' : ' (if needed)'}</span>
          <input type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder={preset?.envVar ? `or set $${preset.envVar}` : ''} />
        </label>
        <label>
          <span>Default model</span>
          <input value={model} onChange={(e) => setModel(e.target.value)} placeholder={preset?.defaultModel || 'pick after testing'} />
        </label>
      </div>
      <button type="button" className="btn primary" disabled={preset?.needsKey && !key} onClick={() => void add()}>
        Add
      </button>
    </div>
  );
}

export function SettingsModal() {
  const providers = useStore((s) => s.providers);
  const set = useStore((s) => s.set);
  return (
    <div className="modal-back" onClick={() => set({ settingsOpen: false })}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Models and keys" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="icon-btn close" onClick={() => set({ settingsOpen: false })} aria-label="Close">
          <Icon name="x" />
        </button>
        <h2>Models and keys</h2>
        <p className="muted">
          Bring your own keys. Each crew member can use a different provider and model. Set it in their settings, or assign one to everyone here. A key only ever leaves this machine on its way to the provider it belongs to, and it never reaches the browser or the logs.
        </p>
        <ul className="providers">
          {providers.map((p) => (
            <ProviderRow key={p.id} p={p} />
          ))}
        </ul>
        <AddProvider />
        <p className="muted small">
          <Icon name="lock" size={13} /> Keys typed here are encrypted (AES-256-GCM) in <span className="mono">data/deepwork.db</span> with a key in <span className="mono">data/master.key</span> or <span className="mono">$DEEPWORK_SECRET</span>. Environment variables are the safest option. They are read at startup and never stored.
        </p>
      </div>
    </div>
  );
}
