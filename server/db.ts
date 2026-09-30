import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import type {
  Agent,
  Artifact,
  ChatMessage,
  DecisionRequest,
  LogEvent,
  Memory,
  Run,
  Task,
} from '../shared/types.ts';

export const ROOT = path.resolve(import.meta.dirname, '..');
export const DATA_DIR = process.env.DEEPWORK_DATA_DIR ?? path.join(ROOT, 'data');
export const WORKSPACE_DIR = process.env.DEEPWORK_WORKSPACE_DIR ?? path.join(ROOT, 'workspace');

fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

export const db = new Database(process.env.DEEPWORK_DB ?? path.join(DATA_DIR, 'deepwork.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS providers (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, label TEXT NOT NULL, base_url TEXT,
  key_enc TEXT, env_var TEXT, default_model TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY, data TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, data TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE, data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_run ON tasks(run_id);

-- Model transcripts, one row per message, so a task can resume after a restart.
CREATE TABLE IF NOT EXISTS transcripts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT NOT NULL, data TEXT NOT NULL, ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS transcripts_owner ON transcripts(owner, id);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY, run_id TEXT, name TEXT NOT NULL, data TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS artifacts_run ON artifacts(run_id);

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(id UNINDEXED, content, tags);

CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY, run_id TEXT, status TEXT NOT NULL, data TEXT NOT NULL, created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, data TEXT NOT NULL, ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS events_run ON events(run_id, id);

CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, data TEXT NOT NULL, ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS chats_agent ON chats(agent_id, ts);
`);

export function getSetting<T>(key: string, fallback: T): T {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row ? (JSON.parse(row.value) as T) : fallback;
}
export function setSetting(key: string, value: unknown) {
  db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    key,
    JSON.stringify(value),
  );
}

export const agents = {
  must(id: string): Agent {
    const found = agents.get(id);
    if (!found) throw new Error(`Unknown crew member ${id}`);
    return found;
  },
  all(): Agent[] {
    return (db.prepare('SELECT data FROM agents ORDER BY sort, rowid').all() as { data: string }[]).map((r) => JSON.parse(r.data));
  },
  get(id: string): Agent | undefined {
    const r = db.prepare('SELECT data FROM agents WHERE id = ?').get(id) as { data: string } | undefined;
    return r ? JSON.parse(r.data) : undefined;
  },
  put(a: Agent) {
    db.prepare('INSERT INTO agents(id, data, sort) VALUES(?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, sort = excluded.sort').run(
      a.id,
      JSON.stringify(a),
      a.sort,
    );
  },
  remove(id: string) {
    db.prepare('DELETE FROM agents WHERE id = ?').run(id);
  },
};

export const runs = {
  must(id: string): Run {
    const found = runs.get(id);
    if (!found) throw new Error(`Unknown mission ${id}`);
    return found;
  },
  get(id: string): Run | undefined {
    const r = db.prepare('SELECT data FROM runs WHERE id = ?').get(id) as { data: string } | undefined;
    return r ? JSON.parse(r.data) : undefined;
  },
  put(run: Run) {
    db.prepare('INSERT INTO runs(id, data, status, created_at) VALUES(?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, status = excluded.status').run(
      run.id,
      JSON.stringify(run),
      run.status,
      run.createdAt,
    );
  },
  recent(limit = 30): Run[] {
    return (db.prepare('SELECT data FROM runs ORDER BY created_at DESC LIMIT ?').all(limit) as { data: string }[]).map((r) => JSON.parse(r.data));
  },
  active(): Run | undefined {
    const r = db
      .prepare(`SELECT data FROM runs WHERE status NOT IN ('completed','failed','cancelled') ORDER BY created_at DESC LIMIT 1`)
      .get() as { data: string } | undefined;
    return r ? JSON.parse(r.data) : undefined;
  },
};

export const tasks = {
  must(id: string): Task {
    const found = tasks.get(id);
    if (!found) throw new Error(`Unknown task ${id}`);
    return found;
  },
  get(id: string): Task | undefined {
    const r = db.prepare('SELECT data FROM tasks WHERE id = ?').get(id) as { data: string } | undefined;
    return r ? JSON.parse(r.data) : undefined;
  },
  byRun(runId: string): Task[] {
    return (db.prepare('SELECT data FROM tasks WHERE run_id = ?').all(runId) as { data: string }[])
      .map((r) => JSON.parse(r.data) as Task)
      .sort((a, b) => a.order - b.order);
  },
  put(t: Task) {
    db.prepare('INSERT INTO tasks(id, run_id, data) VALUES(?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data').run(t.id, t.runId, JSON.stringify(t));
  },
  remove(id: string) {
    db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
  },
};

export const transcripts = {
  load<T>(owner: string): T[] {
    return (db.prepare('SELECT data FROM transcripts WHERE owner = ? ORDER BY id').all(owner) as { data: string }[]).map((r) => JSON.parse(r.data));
  },
  append(owner: string, message: unknown) {
    db.prepare('INSERT INTO transcripts(owner, data, ts) VALUES(?, ?, ?)').run(owner, JSON.stringify(message), Date.now());
  },
  clear(owner: string) {
    db.prepare('DELETE FROM transcripts WHERE owner = ?').run(owner);
  },
};

export const artifacts = {
  get(id: string): Artifact | undefined {
    const r = db.prepare('SELECT data FROM artifacts WHERE id = ?').get(id) as { data: string } | undefined;
    return r ? JSON.parse(r.data) : undefined;
  },
  content(id: string): string | undefined {
    const r = db.prepare('SELECT content FROM artifacts WHERE id = ?').get(id) as { content: string } | undefined;
    return r?.content;
  },
  byRun(runId: string): Artifact[] {
    return (db.prepare('SELECT data FROM artifacts WHERE run_id = ? ORDER BY created_at').all(runId) as { data: string }[]).map((r) =>
      JSON.parse(r.data),
    );
  },
  findByName(runId: string, name: string): Artifact | undefined {
    const r = db.prepare('SELECT data FROM artifacts WHERE run_id = ? AND name = ? ORDER BY created_at DESC LIMIT 1').get(runId, name) as
      | { data: string }
      | undefined;
    return r ? JSON.parse(r.data) : undefined;
  },
  recent(limit = 200): Artifact[] {
    return (db.prepare('SELECT data FROM artifacts ORDER BY created_at DESC LIMIT ?').all(limit) as { data: string }[]).map((r) => JSON.parse(r.data));
  },
  put(a: Artifact, content: string) {
    db.prepare(
      'INSERT INTO artifacts(id, run_id, name, data, content, created_at) VALUES(?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, content = excluded.content',
    ).run(a.id, a.runId, a.name, JSON.stringify(a), content, a.createdAt);
  },
};

export const memories = {
  all(limit = 300): Memory[] {
    return (db.prepare('SELECT data FROM memories ORDER BY created_at DESC LIMIT ?').all(limit) as { data: string }[]).map((r) => JSON.parse(r.data));
  },
  get(id: string): Memory | undefined {
    const r = db.prepare('SELECT data FROM memories WHERE id = ?').get(id) as { data: string } | undefined;
    return r ? JSON.parse(r.data) : undefined;
  },
  put(m: Memory) {
    const tx = db.transaction(() => {
      db.prepare('INSERT INTO memories(id, data, created_at) VALUES(?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data').run(
        m.id,
        JSON.stringify(m),
        m.createdAt,
      );
      db.prepare('DELETE FROM memories_fts WHERE id = ?').run(m.id);
      db.prepare('INSERT INTO memories_fts(id, content, tags) VALUES(?, ?, ?)').run(m.id, m.content, m.tags);
    });
    tx();
  },
  remove(id: string) {
    db.prepare('DELETE FROM memories WHERE id = ?').run(id);
    db.prepare('DELETE FROM memories_fts WHERE id = ?').run(id);
  },
  /** Full-text search. Words are OR-ed so partial matches still surface; bm25 ranks them. */
  search(query: string, opts: { agentId?: string | null; limit?: number } = {}): Memory[] {
    const words = (query.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).slice(0, 24);
    if (!words.length) return [];
    const match = [...new Set(words)].map((w) => `"${w}"`).join(' OR ');
    const ids = db
      .prepare('SELECT id FROM memories_fts WHERE memories_fts MATCH ? ORDER BY bm25(memories_fts) LIMIT ?')
      .all(match, (opts.limit ?? 6) * 3) as { id: string }[];
    const out: Memory[] = [];
    for (const { id } of ids) {
      const m = memories.get(id);
      if (!m) continue;
      if (m.scope === 'agent' && m.agentId !== opts.agentId) continue;
      out.push(m);
      if (out.length >= (opts.limit ?? 6)) break;
    }
    return out;
  },
  pinned(): Memory[] {
    return memories.all(500).filter((m) => m.pinned);
  },
};

export const requests = {
  get(id: string): DecisionRequest | undefined {
    const r = db.prepare('SELECT data FROM requests WHERE id = ?').get(id) as { data: string } | undefined;
    return r ? JSON.parse(r.data) : undefined;
  },
  put(q: DecisionRequest) {
    db.prepare('INSERT INTO requests(id, run_id, status, data, created_at) VALUES(?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, status = excluded.status').run(
      q.id,
      q.runId,
      q.status,
      JSON.stringify(q),
      q.createdAt,
    );
  },
  open(): DecisionRequest[] {
    return (db.prepare(`SELECT data FROM requests WHERE status = 'open' ORDER BY created_at`).all() as { data: string }[]).map((r) => JSON.parse(r.data));
  },
  byRun(runId: string): DecisionRequest[] {
    return (db.prepare('SELECT data FROM requests WHERE run_id = ? ORDER BY created_at').all(runId) as { data: string }[]).map((r) =>
      JSON.parse(r.data),
    );
  },
};

export const events = {
  insert(e: Omit<LogEvent, 'id'>): LogEvent {
    const info = db.prepare('INSERT INTO events(run_id, data, ts) VALUES(?, ?, ?)').run(e.runId, JSON.stringify(e), e.ts);
    return { ...e, id: Number(info.lastInsertRowid) };
  },
  recent(runId: string | null, limit = 400): LogEvent[] {
    const rows = (
      runId
        ? db.prepare('SELECT id, data FROM events WHERE run_id = ? ORDER BY id DESC LIMIT ?').all(runId, limit)
        : db.prepare('SELECT id, data FROM events ORDER BY id DESC LIMIT ?').all(limit)
    ) as { id: number; data: string }[];
    return rows.map((r) => ({ ...JSON.parse(r.data), id: r.id })).reverse();
  },
};

export const chats = {
  put(m: ChatMessage) {
    db.prepare('INSERT INTO chats(id, agent_id, data, ts) VALUES(?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data').run(
      m.id,
      m.agentId,
      JSON.stringify(m),
      m.ts,
    );
  },
  byAgent(agentId: string, limit = 60): ChatMessage[] {
    return (db.prepare('SELECT data FROM chats WHERE agent_id = ? ORDER BY ts DESC LIMIT ?').all(agentId, limit) as { data: string }[])
      .map((r) => JSON.parse(r.data))
      .reverse();
  },
};
