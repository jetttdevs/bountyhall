// Outbound webhooks. When something happens to an intent, the poster and the
// winning solver (never the actor who caused it) get a signed POST:
//
//   X-Bountyhall-Event:     intent.awarded
//   X-Bountyhall-Timestamp: 1790000000000
//   X-Bountyhall-Signature: base64 ed25519 over `${timestamp}.${body}`
//
// Verify with the public key at /.well-known/bountyhall.json. Deliveries are
// best effort: one retry, 5 second timeout, no queue.
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { HttpError } from './util.js';

// bid.placed only matters to the poster; everything else goes to both sides.
const POSTER_ONLY = new Set(['bid.placed']);

export function isPrivateAddress(ip) {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivateAddress(v.slice(7));
  return v === '::' || v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb');
}

export function validateWebhookUrl(raw, { allowPrivate = false } = {}) {
  if (raw === null || raw === '') return null;
  if (typeof raw !== 'string' || raw.length > 500) throw new HttpError(400, 'webhook_url must be a URL string', 'invalid_input');
  let url;
  try { url = new URL(raw); } catch { throw new HttpError(400, 'webhook_url is not a valid URL', 'invalid_input'); }
  if (url.username || url.password) throw new HttpError(400, 'webhook_url must not contain credentials', 'invalid_input');
  if (allowPrivate) {
    if (!['http:', 'https:'].includes(url.protocol)) throw new HttpError(400, 'webhook_url must be http(s)', 'invalid_input');
    return url.toString();
  }
  if (url.protocol !== 'https:') throw new HttpError(400, 'webhook_url must use https', 'invalid_input');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || (isIP(host) && isPrivateAddress(host))) {
    throw new HttpError(400, 'webhook_url must point to a public host', 'invalid_input');
  }
  return url.toString();
}

export function createDispatcher(market, { allowPrivate = false, fetchImpl = fetch, log = console } = {}) {
  async function resolvesPublic(url) {
    if (allowPrivate) return true;
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
    try {
      const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
      return addrs.length > 0 && addrs.every((a) => !isPrivateAddress(a.address));
    } catch { return false; }
  }

  async function send(url, event, payload) {
    const body = JSON.stringify(payload);
    const ts = String(Date.now());
    const headers = {
      'Content-Type': 'application/json', 'User-Agent': 'Bountyhall-Webhooks/1',
      'X-Bountyhall-Event': event, 'X-Bountyhall-Timestamp': ts, 'X-Bountyhall-Signature': market.sign(`${ts}.${body}`),
    };
    if (!(await resolvesPublic(url))) return log.warn?.(`[webhook] skipped ${url}: resolves to a private address`);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetchImpl(url, { method: 'POST', headers, body, redirect: 'manual', signal: AbortSignal.timeout(5000) });
        if (res.status < 500) return res.status;
      } catch {}
    }
    log.warn?.(`[webhook] delivery to ${url} failed`);
  }

  // Returns the promise of all deliveries so tests can await them.
  return function dispatch(ev) {
    if (!ev.intent_id || ev.type === 'intent.created') return Promise.resolve([]);
    const p = market.participants(ev.intent_id);
    if (!p) return Promise.resolve([]);
    const targets = new Set([p.poster_id]);
    if (!POSTER_ONLY.has(ev.type) && p.solver_id) targets.add(p.solver_id);
    targets.delete(ev.actor_id);
    const jobs = [];
    for (const accountId of targets) {
      const url = market.webhookUrl(accountId);
      if (!url) continue;
      const payload = { event: ev.type, seq: ev.seq, intent_id: ev.intent_id, recipient_id: accountId, data: ev.data, created_at: ev.created_at };
      jobs.push(send(url, ev.type, payload).catch(() => {}));
    }
    return Promise.all(jobs);
  };
}
