import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import type { Readable } from 'node:stream';
import zlib from 'node:zlib';

// Agents may only reach the public internet. Anything that resolves to a private,
// loopback, link-local or otherwise internal address is refused, and redirects are
// followed by hand so every hop gets the same check.

function privateV4(ip: string) {
  const [a, b] = ip.split('.').map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function privateIp(ip: string): boolean {
  if (net.isIPv4(ip)) return privateV4(ip);
  const v = ip.toLowerCase();
  if (v === '::' || v === '::1') return true;
  const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return privateV4(mapped[1]);
  return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(v);
}

async function assertPublic(url: URL) {
  if (!/^https?:$/.test(url.protocol)) throw new Error(`Only http(s) URLs are allowed (got ${url.protocol})`);
  if (url.username || url.password) throw new Error('URLs with embedded credentials are not allowed');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (/^(localhost|.*\.local|.*\.internal)$/i.test(host)) throw new Error('Internal hostnames are not allowed');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (!addrs.length) throw new Error(`Could not resolve ${host}`);
  for (const a of addrs) if (privateIp(a.address)) throw new Error(`${host} resolves to a private address; refusing`);
}

export interface FetchResult {
  status: number;
  finalUrl: string;
  contentType: string;
  body: string;
  truncated: boolean;
}

/**
 * Resolves and checks the address inside the socket's own lookup, so the address we
 * validated is the address we connect to (no window for DNS rebinding).
 */
const guardedLookup: net.LookupFunction = (hostname, options, cb) => {
  dns
    .lookup(hostname, { all: true })
    .then((addrs) => {
      const bad = addrs.find((a) => privateIp(a.address));
      if (!addrs.length || bad) return cb(Object.assign(new Error(`${hostname} resolves to a private address; refusing`), { code: 'EPRIVATE' }), '', 4);
      // Node's LookupFunction type has one callback shape; with `all: true` sockets expect the address array.
      if ((options as { all?: boolean }).all) return (cb as unknown as (e: null, a: typeof addrs) => void)(null, addrs);
      cb(null, addrs[0].address, addrs[0].family);
    })
    .catch((e) => cb(e, '', 4));
};

function request(url: URL, init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal }): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(url, { method: init.method, headers: init.headers, lookup: guardedLookup, signal: init.signal }, resolve);
    req.on('error', reject);
    if (init.body) req.write(init.body);
    req.end();
  });
}

function decoded(res: http.IncomingMessage): Readable {
  const enc = String(res.headers['content-encoding'] ?? '').toLowerCase();
  if (enc === 'gzip' || enc === 'x-gzip') return res.pipe(zlib.createGunzip());
  if (enc === 'deflate') return res.pipe(zlib.createInflate());
  if (enc === 'br') return res.pipe(zlib.createBrotliDecompress());
  return res;
}

export async function safeFetch(
  rawUrl: string,
  init: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal; maxBytes?: number } = {},
): Promise<FetchResult> {
  let url = new URL(rawUrl);
  const maxBytes = init.maxBytes ?? 2_000_000;
  const timeout = AbortSignal.timeout(20_000);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  const headers: Record<string, string> = { 'user-agent': 'Deepwork-crew/0.1 (+local agent workspace)', 'accept-encoding': 'gzip, deflate, br', ...init.headers };
  if (init.body) headers['content-length'] = String(Buffer.byteLength(init.body));

  for (let hop = 0; hop < 4; hop++) {
    await assertPublic(url);
    const res = await request(url, { method: init.method ?? 'GET', headers, body: init.body, signal });
    const status = res.statusCode ?? 0;
    if (status >= 300 && status < 400 && res.headers.location) {
      res.resume();
      url = new URL(res.headers.location, url);
      continue;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    for await (const chunk of decoded(res)) {
      size += chunk.length;
      if (size > maxBytes) {
        truncated = true;
        res.destroy();
        break;
      }
      chunks.push(chunk);
    }
    return { status, finalUrl: url.toString(), contentType: String(res.headers['content-type'] ?? ''), body: Buffer.concat(chunks).toString('utf8'), truncated };
  }
  throw new Error('Too many redirects');
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function htmlToText(html: string): { title: string; text: string } {
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').trim();
  const text = html
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h\d|\/tr)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#\d+|#x[0-9a-f]+|\w+);/gi, (m, e: string) => {
      if (e[0] === '#') {
        const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();
  return { title: title.replace(/\s+/g, ' '), text };
}
