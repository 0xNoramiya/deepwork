import { nanoid } from 'nanoid';
import type { ProviderKind, ProviderPublic } from '../../shared/types.ts';
import { db } from '../db.ts';
import { decrypt, encrypt, hint, registerSecret } from '../secrets.ts';
import { AnthropicProvider } from './anthropic.ts';
import { DemoProvider } from './demo.ts';
import { OpenAIProvider } from './openai.ts';
import type { ModelProvider } from './types.ts';

export const PRESETS: { id: string; kind: ProviderKind; label: string; baseUrl: string | null; envVar: string; defaultModel: string; needsKey: boolean }[] = [
  { id: 'anthropic', kind: 'anthropic', label: 'Anthropic', baseUrl: null, envVar: 'ANTHROPIC_API_KEY', defaultModel: 'claude-opus-5-5', needsKey: true },
  { id: 'openai', kind: 'openai', label: 'OpenAI', baseUrl: null, envVar: 'OPENAI_API_KEY', defaultModel: 'gpt-5', needsKey: true },
  { id: 'openrouter', kind: 'openai_compat', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', envVar: 'OPENROUTER_API_KEY', defaultModel: 'openrouter/auto', needsKey: true },
  { id: 'gateway', kind: 'openai_compat', label: 'Vercel AI Gateway', baseUrl: 'https://ai-gateway.vercel.sh/v1', envVar: 'AI_GATEWAY_API_KEY', defaultModel: '', needsKey: true },
  { id: 'gemini', kind: 'openai_compat', label: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/', envVar: 'GEMINI_API_KEY', defaultModel: 'gemini-2.5-flash', needsKey: true },
  { id: 'groq', kind: 'openai_compat', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', envVar: 'GROQ_API_KEY', defaultModel: '', needsKey: true },
  { id: 'mistral', kind: 'openai_compat', label: 'Mistral', baseUrl: 'https://api.mistral.ai/v1', envVar: 'MISTRAL_API_KEY', defaultModel: '', needsKey: true },
  { id: 'deepseek', kind: 'openai_compat', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', envVar: 'DEEPSEEK_API_KEY', defaultModel: 'deepseek-chat', needsKey: true },
  { id: 'xai', kind: 'openai_compat', label: 'xAI', baseUrl: 'https://api.x.ai/v1', envVar: 'XAI_API_KEY', defaultModel: '', needsKey: true },
  { id: 'ollama', kind: 'openai_compat', label: 'Ollama (local)', baseUrl: 'http://localhost:11434/v1', envVar: '', defaultModel: '', needsKey: false },
  { id: 'lmstudio', kind: 'openai_compat', label: 'LM Studio (local)', baseUrl: 'http://localhost:1234/v1', envVar: '', defaultModel: '', needsKey: false },
  { id: 'custom', kind: 'openai_compat', label: 'Custom (OpenAI-compatible)', baseUrl: '', envVar: '', defaultModel: '', needsKey: false },
];

interface Row {
  id: string;
  kind: ProviderKind;
  label: string;
  base_url: string | null;
  key_enc: string | null;
  env_var: string | null;
  default_model: string;
  created_at: number;
}

const demo = new DemoProvider();
const cache = new Map<string, ModelProvider>();

/** Environment keys become providers automatically; they are read, never stored. */
export function syncEnvProviders() {
  for (const p of PRESETS) {
    if (!p.envVar || !process.env[p.envVar]) continue;
    const id = `env-${p.id}`;
    registerSecret(process.env[p.envVar]);
    const exists = db.prepare('SELECT 1 FROM providers WHERE id = ?').get(id);
    if (!exists) {
      db.prepare('INSERT INTO providers(id, kind, label, base_url, key_enc, env_var, default_model, created_at) VALUES(?,?,?,?,?,?,?,?)').run(
        id,
        p.kind,
        `${p.label} (env)`,
        p.baseUrl,
        null,
        p.envVar,
        p.defaultModel,
        Date.now(),
      );
    }
  }
}

function rows(): Row[] {
  return db.prepare('SELECT * FROM providers ORDER BY created_at').all() as Row[];
}

function keyFor(r: Row): string | null {
  if (r.env_var) return process.env[r.env_var] ?? null;
  if (r.key_enc) {
    const k = decrypt(r.key_enc);
    registerSecret(k);
    return k;
  }
  return null;
}

export function publicProvider(r: Row): ProviderPublic {
  const key = r.env_var ? (process.env[r.env_var] ?? null) : r.key_enc ? decrypt(r.key_enc) : null;
  return {
    id: r.id,
    kind: r.kind,
    label: r.label,
    baseUrl: r.base_url,
    keySource: r.env_var ? (key ? 'env' : 'none') : r.key_enc ? 'stored' : 'none',
    keyHint: key ? hint(key) : null,
    envVar: r.env_var,
    defaultModel: r.default_model,
    createdAt: r.created_at,
  };
}

export function listProviders(): ProviderPublic[] {
  return [
    { id: 'demo', kind: 'demo', label: demo.label, baseUrl: null, keySource: 'none', keyHint: null, envVar: null, defaultModel: 'simulated', createdAt: 0 },
    ...rows().map(publicProvider),
  ];
}

export function getProvider(id: string | null): ModelProvider | null {
  if (!id) return null;
  if (id === 'demo') return demo;
  const hit = cache.get(id);
  if (hit) return hit;
  const r = db.prepare('SELECT * FROM providers WHERE id = ?').get(id) as Row | undefined;
  if (!r) return null;
  const key = keyFor(r);
  const p: ModelProvider =
    r.kind === 'anthropic'
      ? new AnthropicProvider(r.id, r.label, key ?? '', r.base_url)
      : new OpenAIProvider(r.id, r.label, r.kind === 'openai' ? 'openai' : 'openai_compat', key, r.base_url);
  cache.set(id, p);
  return p;
}

export function providerMeta(id: string | null): { kind: ProviderKind; baseUrl: string | null; label: string } | null {
  if (!id) return null;
  if (id === 'demo') return { kind: 'demo', baseUrl: null, label: demo.label };
  const r = db.prepare('SELECT kind, base_url, label FROM providers WHERE id = ?').get(id) as { kind: ProviderKind; base_url: string | null; label: string } | undefined;
  return r ? { kind: r.kind, baseUrl: r.base_url, label: r.label } : null;
}

export function addProvider(input: { kind: ProviderKind; label: string; baseUrl: string | null; apiKey: string | null; defaultModel: string }): ProviderPublic {
  if (input.kind === 'demo') throw new Error('The demo provider is built in.');
  if (input.baseUrl) {
    const u = new URL(input.baseUrl);
    if (!/^https?:$/.test(u.protocol)) throw new Error('Base URL must be http(s).');
  }
  const id = `p-${nanoid(8)}`;
  if (input.apiKey) registerSecret(input.apiKey);
  db.prepare('INSERT INTO providers(id, kind, label, base_url, key_enc, env_var, default_model, created_at) VALUES(?,?,?,?,?,?,?,?)').run(
    id,
    input.kind,
    input.label.slice(0, 60),
    input.baseUrl || null,
    input.apiKey ? encrypt(input.apiKey) : null,
    null,
    input.defaultModel,
    Date.now(),
  );
  return publicProvider(db.prepare('SELECT * FROM providers WHERE id = ?').get(id) as Row);
}

export function updateProvider(id: string, patch: { label?: string; baseUrl?: string | null; apiKey?: string | null; defaultModel?: string }): ProviderPublic {
  const r = db.prepare('SELECT * FROM providers WHERE id = ?').get(id) as Row | undefined;
  if (!r) throw new Error('No such provider');
  if (patch.apiKey && r.env_var) throw new Error('This key comes from an environment variable; change it there.');
  if (patch.apiKey) registerSecret(patch.apiKey);
  db.prepare('UPDATE providers SET label = ?, base_url = ?, key_enc = ?, default_model = ? WHERE id = ?').run(
    patch.label?.slice(0, 60) ?? r.label,
    patch.baseUrl === undefined ? r.base_url : patch.baseUrl || null,
    patch.apiKey ? encrypt(patch.apiKey) : r.key_enc,
    patch.defaultModel ?? r.default_model,
    id,
  );
  cache.delete(id);
  return publicProvider(db.prepare('SELECT * FROM providers WHERE id = ?').get(id) as Row);
}

export function removeProvider(id: string) {
  db.prepare('DELETE FROM providers WHERE id = ?').run(id);
  cache.delete(id);
}
