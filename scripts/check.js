#!/usr/bin/env node
// Check a running Bountyhall from the outside. Read-only unless --write.
//
//   npm run check -- --url https://your-app.up.railway.app
//   npm run check -- --url https://… --admin $ADMIN_TOKEN     # also the admin setup check
//   npm run check -- --url https://… --write                 # also signs up and posts (credits mode only)
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({ options: { url: { type: 'string' }, admin: { type: 'string' }, write: { type: 'boolean', default: false } } });
if (!args.url) { console.error('usage: npm run check -- --url https://your-app'); process.exit(2); }
const base = args.url.replace(/\/$/, '');
let failed = 0;

async function step(name, fn) {
  try {
    const detail = await fn();
    console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (err) {
    failed++;
    console.log(`FAIL  ${name} — ${err.message}`);
  }
}
async function get(path, { json = true, headers = {} } = {}) {
  const res = await fetch(base + path, { headers, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`${path} returned ${res.status}`);
  return json ? res.json() : res.text();
}
async function post(path, body, headers = {}) {
  const res = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} returned ${res.status}: ${data.error || ''}`);
  return data;
}

let stats, pay;
await step('health check', async () => { const t = await get('/healthz', { json: false }); if (t.trim() !== 'ok') throw new Error(t); });
await step('stats', async () => { stats = await get('/api/stats'); return `v${stats.version ?? '?'} · ${stats.agents} agents · ${stats.open_intents} open · judge: ${stats.judge} · house agent: ${stats.house_agent ?? 'off'}`; });
await step('payments', async () => {
  pay = await get('/api/payments');
  if (pay.mode !== 'token') return 'test credits';
  if (!pay.ready) throw new Error(`token mode but the chain is not connected (decimals ${pay.decimals})`);
  return `${pay.symbol} on ${pay.chain_name} (${pay.chain_id}), treasury ${pay.deposit_address}, ${pay.decimals} decimals`;
});
for (const page of ['/', '/intents', '/agents', '/docs', '/post', '/join', '/me', '/admin', ...(pay?.mode === 'token' ? ['/wallet'] : [])]) {
  await step(`page ${page}`, async () => { const html = await get(page, { json: false }); if (!html.includes('Bountyhall')) throw new Error('unexpected page'); });
}
await step('solver.md', async () => {
  const md = await get('/solver.md', { json: false });
  if (!md.includes('solver guide')) throw new Error('unexpected content');
  const origin = md.match(/Base URL: (\S+)/)?.[1];
  if (origin && origin !== base) throw new Error(`advertises ${origin}; set PUBLIC_URL=${base}`);
  return origin ? `base URL ${origin}` : '';
});
await step('well-known', async () => { const w = await get('/.well-known/bountyhall.json'); if (!w.receipt_signing?.public_key_spki_base64) throw new Error('no signing key'); });
await step('MCP handshake', async () => {
  const r = await post('/mcp', { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'check', version: '1' } } });
  const tools = await post('/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/list' });
  return `${r.result.serverInfo.name} ${r.result.serverInfo.version}, ${tools.result.tools.length} tools`;
});
await step('live event stream', async () => {
  const ctrl = new AbortController();
  const res = await fetch(base + '/api/stream', { signal: ctrl.signal });
  if (!res.ok || !String(res.headers.get('content-type')).startsWith('text/event-stream')) { ctrl.abort(); throw new Error(`/api/stream returned ${res.status} ${res.headers.get('content-type')}`); }
  const first = await res.body.getReader().read();
  ctrl.abort();
  if (!new TextDecoder().decode(first.value).includes(':')) throw new Error('no SSE preamble');
});
if (args.admin) {
  await step('admin setup check', async () => {
    const h = await get('/api/admin/health', { headers: { Authorization: `Bearer ${args.admin}` } });
    for (const c of h.checks) console.log(`      ${c.level === 'ok' ? '✓' : c.level === 'warn' ? '!' : '✗'} ${c.item}: ${c.detail}`);
    if (!h.ok) throw new Error('some checks need attention');
  });
}
if (args.write) {
  if (pay?.mode === 'token') console.log('SKIP  write checks: token mode has no free credits to test with');
  else {
    await step('sign up, post and cancel an intent', async () => {
      const a = await post('/api/accounts', { name: `check-${Date.now().toString(36)}`, kind: 'human', bio: 'automated check' });
      const h = { Authorization: `Bearer ${a.api_key}` };
      const i = await post('/api/intents', { title: 'Automated check intent', body: 'Posted by scripts/check.js and cancelled right away.', budget: 1 }, h);
      await post(`/api/intents/${i.id}/cancel`, {}, h);
      return i.id;
    });
  }
}
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
