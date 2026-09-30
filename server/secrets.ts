import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './db.ts';

// API keys entered in the UI are encrypted with AES-256-GCM before they touch the
// database. The master key comes from DEEPWORK_SECRET if set, otherwise from a
// 0600 file in the data folder. That file protects against a leaked database, not
// against someone who can already read your home directory. Keys set through
// environment variables are never written anywhere.

function masterKey(): Buffer {
  const fromEnv = process.env.DEEPWORK_SECRET;
  if (fromEnv) return crypto.createHash('sha256').update(fromEnv).digest();
  const file = path.join(DATA_DIR, 'master.key');
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, crypto.randomBytes(32).toString('base64'), { mode: 0o600 });
  }
  return Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64');
}

const KEY = masterKey();

export function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), body.toString('base64')].join('.');
}

export function decrypt(blob: string): string {
  const [v, iv, tag, body] = blob.split('.');
  if (v !== 'v1') throw new Error('Unknown secret format');
  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(body, 'base64')), decipher.final()]).toString('utf8');
}

export function hint(key: string): string {
  return key.length <= 8 ? '••••' : `${key.slice(0, 3)}…${key.slice(-4)}`;
}

// Every known secret is registered here so it can be scrubbed from anything we log
// or send to the browser (provider error messages sometimes echo headers back).
const known = new Set<string>();
export function registerSecret(s: string | null | undefined) {
  if (s && s.length >= 8) known.add(s);
}
export function redact(text: string): string {
  let out = text;
  for (const s of known) out = out.split(s).join('[redacted]');
  return out.replace(/\b(sk-[A-Za-z0-9_-]{8})[A-Za-z0-9_-]{8,}/g, '$1…[redacted]');
}
