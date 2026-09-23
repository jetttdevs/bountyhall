// MCP server, signed webhooks, search/tags, profile updates and migrations.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createPublicKey, verify } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/server.js';
import { openDb } from '../src/db.js';
import { validateWebhookUrl, isPrivateAddress } from '../src/webhooks.js';

let app, base, hook, hookUrl;
const received = [];

before(async () => {
  process.env.SIGNUP_PER_HOUR = '1000';
  app = createApp({ dbFile: ':memory:', sweepMs: 0, judge: async () => null, webhooks: { allowPrivate: true } });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  hook = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { received.push({ path: req.url, headers: req.headers, body }); res.end('ok'); });
  });
  await new Promise((r) => hook.listen(0, r));
  hookUrl = `http://127.0.0.1:${hook.address().port}`;
});
after(() => {
  app.server.closeAllConnections(); app.server.close();
  hook.closeAllConnections(); hook.close();
});

async function call(method, path, { key, body } = {}) {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}
const ok = async (p) => { const r = await p; assert.ok(r.status < 300, `got ${r.status}: ${JSON.stringify(r.data)}`); return r.data; };
let n = 0;
const signup = async (kind = 'agent') => { const o = await ok(call('POST', '/api/accounts', { body: { name: `f${kind}${++n}`, kind } })); return { ...o.account, key: o.api_key }; };

let rpcId = 0;
async function rpc(method, params, key, { notification = false } = {}) {
  const msg = { jsonrpc: '2.0', method, ...(params ? { params } : {}), ...(notification ? {} : { id: ++rpcId }) };
  const res = await fetch(base + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(key ? { Authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify(msg) });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null };
}
const tool = async (name, args, key) => {
  const r = await rpc('tools/call', { name, arguments: args }, key);
  assert.equal(r.status, 200);
  const result = r.data.result;
  return { isError: result.isError, text: result.content[0].text, json: result.isError ? null : JSON.parse(result.content[0].text) };
};

test('MCP: handshake, tool list and protocol errors', async () => {
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(init.status, 200);
  assert.equal(init.data.result.protocolVersion, '2025-06-18');
  assert.equal(init.data.result.serverInfo.name, 'bountyhall');
  assert.ok(init.data.result.capabilities.tools);
  const old = await rpc('initialize', { protocolVersion: '1999-01-01' });
  assert.equal(old.data.result.protocolVersion, '2025-06-18', 'unknown versions get our latest');
  const note = await rpc('notifications/initialized', null, null, { notification: true });
  assert.equal(note.status, 202);
  const list = await rpc('tools/list');
  const names = list.data.result.tools.map((t) => t.name);
  for (const t of ['list_intents', 'get_intent', 'place_bid', 'deliver', 'post_intent', 'award', 'accept', 'reject']) assert.ok(names.includes(t), t);
  for (const t of list.data.result.tools) assert.equal(t.inputSchema.type, 'object');
  assert.equal((await rpc('nope/method')).data.error.code, -32601);
  assert.equal((await rpc('tools/call', { name: 'no_such_tool' })).data.error.code, -32602);
  assert.equal((await rpc('ping')).data.result && true, true);
  assert.equal((await fetch(base + '/mcp')).status, 405);
  const bad = await fetch(base + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{oops' });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error.code, -32700);
  const badKey = await rpc('tools/list', null, 'bh_wrong');
  assert.equal(badKey.status, 401);
  const batch = await fetch(base + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/initialized' }]) });
  const out = await batch.json();
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 1);
});

test('MCP: a full job from post to payout, entirely through tools', async () => {
  const poster = await signup('human'); const agent = await signup();
  const anon = await tool('place_bid', { intent_id: 'int_x', price: 1, eta_hours: 1, pitch: 'no key here at all' });
  assert.equal(anon.isError, true);
  assert.match(anon.text, /API key/);
  const intent = (await tool('post_intent', { title: 'Name a sourdough bakery', body: 'Five name ideas with a one-line rationale each.', budget: 100, tags: ['naming'] }, poster.key)).json;
  const listed = (await tool('list_intents', { tag: 'naming' })).json;
  assert.ok(listed.some((i) => i.id === intent.id));
  const bid = (await tool('place_bid', { intent_id: intent.id, price: 70, eta_hours: 2, pitch: 'Five warm, memorable names.' }, agent.key)).json;
  const tooHigh = await tool('place_bid', { intent_id: intent.id, price: 500, eta_hours: 2, pitch: 'Way over the budget.' }, agent.key);
  assert.equal(tooHigh.isError, true);
  assert.match(tooHigh.text, /invalid_input/);
  await tool('award', { intent_id: intent.id, bid_id: bid.id }, poster.key);
  const work = (await tool('my_work', {}, agent.key)).json;
  assert.equal(work.solving[0].id, intent.id);
  await tool('deliver', { intent_id: intent.id, content: '1. Crumb & Co.\n2. Rise\n3. Wild Yeast\n4. Proof\n5. The Long Ferment' }, agent.key);
  const done = (await tool('accept', { intent_id: intent.id, rating: 5 }, poster.key)).json;
  assert.equal(done.status, 'completed');
  const me = (await tool('my_account', {}, agent.key)).json;
  assert.equal(me.balance, 1000 + 69);
  const noPay = await tool('my_wallet', {}, agent.key);
  assert.equal(noPay.isError, true);
  assert.match(noPay.text, /test credits/);
  const seen = (await tool('get_intent', { intent_id: intent.id })).json;
  assert.match(seen.delivery.content, /Crumb/);
  assert.equal(app.market.ledgerTotal(), 0);
});

test('webhooks: signed, routed to the right side, never to the actor', async () => {
  const poster = await signup('human'); const agent = await signup();
  const set = await ok(call('PATCH', '/api/me', { key: poster.key, body: { webhook_url: `${hookUrl}/poster`, bio: 'I post things' } }));
  assert.equal(set.webhook_url, `${hookUrl}/poster`);
  assert.equal(set.bio, 'I post things');
  await ok(call('PATCH', '/api/me', { key: agent.key, body: { webhook_url: `${hookUrl}/agent` } }));
  const pub = await ok(call('GET', `/api/accounts/${agent.name}`));
  assert.equal(pub.webhook_url, undefined, 'webhook URLs are private');
  assert.equal((await ok(call('GET', '/api/me', { key: agent.key }))).webhook_url, `${hookUrl}/agent`);

  received.length = 0;
  const i = await ok(call('POST', '/api/intents', { key: poster.key, body: { title: 'Webhook test job', body: 'Anything, this is a webhook test.', budget: 50 } }));
  await ok(call('POST', `/api/intents/${i.id}/bids`, { key: agent.key, body: { price: 40, eta_hours: 1, pitch: 'Happy to take it on.' } }));
  await ok(call('POST', `/api/intents/${i.id}/award`, { key: poster.key, body: {} }));
  await ok(call('POST', `/api/intents/${i.id}/deliver`, { key: agent.key, body: { content: 'done' } }));
  await ok(call('POST', `/api/intents/${i.id}/accept`, { key: poster.key, body: {} }));
  await new Promise((r) => setTimeout(r, 20));
  await app.settleWebhooks();

  const byPath = (p) => received.filter((r) => r.path === p).map((r) => r.headers['x-bountyhall-event']);
  assert.deepEqual(byPath('/poster'), ['bid.placed', 'intent.delivered', 'intent.completed']);
  assert.deepEqual(byPath('/agent'), ['intent.awarded', 'intent.completed']);

  const wk = await ok(call('GET', '/.well-known/bountyhall.json'));
  const key = createPublicKey({ key: Buffer.from(wk.receipt_signing.public_key_spki_base64, 'base64'), format: 'der', type: 'spki' });
  for (const r of received) {
    const signed = Buffer.from(`${r.headers['x-bountyhall-timestamp']}.${r.body}`);
    assert.ok(verify(null, signed, key, Buffer.from(r.headers['x-bountyhall-signature'], 'base64')), 'signature verifies');
    const payload = JSON.parse(r.body);
    assert.equal(payload.intent_id, i.id);
    assert.equal(payload.event, r.headers['x-bountyhall-event']);
    assert.equal(payload.data.price, payload.event === 'intent.awarded' ? 40 : undefined);
  }
  const forged = received[0];
  assert.ok(!verify(null, Buffer.from(`${forged.headers['x-bountyhall-timestamp']}.${forged.body.replace('"', '"x')}`), key, Buffer.from(forged.headers['x-bountyhall-signature'], 'base64')));

  // clearing the webhook stops deliveries
  await ok(call('PATCH', '/api/me', { key: poster.key, body: { webhook_url: null } }));
  received.length = 0;
  const j = await ok(call('POST', '/api/intents', { key: poster.key, body: { title: 'Another job', body: 'No webhook this time.', budget: 10 } }));
  await ok(call('POST', `/api/intents/${j.id}/bids`, { key: agent.key, body: { price: 10, eta_hours: 1, pitch: 'Bid that notifies nobody.' } }));
  await new Promise((r) => setTimeout(r, 20));
  await app.settleWebhooks();
  assert.equal(received.length, 0);
  assert.equal((await ok(call('GET', '/api/me', { key: poster.key }))).webhook_url, null);
});

test('webhook URLs: only public https targets are accepted', () => {
  assert.equal(validateWebhookUrl('https://example.com/hook'), 'https://example.com/hook');
  assert.equal(validateWebhookUrl(null), null);
  assert.equal(validateWebhookUrl(''), null);
  for (const bad of ['http://example.com/hook', 'https://localhost/x', 'https://127.0.0.1/x', 'https://10.1.2.3/x', 'https://192.168.1.10/x',
    'https://172.20.0.1/x', 'https://169.254.169.254/latest', 'https://[::1]/x', 'https://[fd00::1]/x', 'https://user:pw@example.com/x',
    'https://printer.local/x', 'https://db.internal/x', 'ftp://example.com/x', 'not a url', 42]) {
    assert.throws(() => validateWebhookUrl(bad), /webhook_url/, String(bad));
  }
  for (const ip of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.0.1', '169.254.1.1', '100.64.0.1', '0.0.0.0', '::1', 'fe80::1', 'fc00::1', '::ffff:10.0.0.1']) assert.ok(isPrivateAddress(ip), ip);
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700::1111']) assert.ok(!isPrivateAddress(ip), ip);
});

test('PATCH /api/me refuses private webhooks when the server does not allow them', async () => {
  const strict = createApp({ dbFile: ':memory:', sweepMs: 0 });
  await new Promise((r) => strict.server.listen(0, r));
  const b = `http://127.0.0.1:${strict.server.address().port}`;
  try {
    const acct = await (await fetch(b + '/api/accounts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'strict1', kind: 'agent' }) })).json();
    const r = await fetch(b + '/api/me', { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${acct.api_key}` }, body: JSON.stringify({ webhook_url: 'http://127.0.0.1:9/x' }) });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /https/);
  } finally { strict.server.closeAllConnections(); strict.server.close(); }
});

test('search and tag filters, in the API and on the website', async () => {
  const poster = await signup('human');
  await ok(call('POST', '/api/intents', { key: poster.key, body: { title: 'Translate a menu to Japanese', body: 'Ramen shop menu, 40 items.', budget: 30, tags: ['translation', 'food'] } }));
  await ok(call('POST', '/api/intents', { key: poster.key, body: { title: 'Logo for a ramen shop', body: 'Bold, red, readable.', budget: 30, tags: ['design'] } }));
  const byTag = await ok(call('GET', '/api/intents?status=open&tag=translation'));
  assert.deepEqual(byTag.intents.map((i) => i.title), ['Translate a menu to Japanese']);
  const byQ = await ok(call('GET', '/api/intents?status=open&q=ramen'));
  assert.equal(byQ.intents.length, 2);
  const both = await ok(call('GET', '/api/intents?status=open&q=ramen&tag=design'));
  assert.deepEqual(both.intents.map((i) => i.title), ['Logo for a ramen shop']);
  assert.equal((await ok(call('GET', '/api/intents?q=%25'))).intents.length, 0, 'LIKE wildcards are escaped');
  assert.equal((await ok(call('GET', '/api/intents?tag=food%25'))).intents.length, 0);
  const html = await (await fetch(`${base}/intents?status=open&tag=design&q=ramen`)).text();
  assert.match(html, /Logo for a ramen shop/);
  assert.doesNotMatch(html, /Translate a menu/);
  assert.match(html, /#design/);
  const page = await (await fetch(`${base}/intents?q=${encodeURIComponent('<script>')}`)).text();
  assert.doesNotMatch(page, /value="<script>"/, 'search box value is escaped');
});

test('migration adds webhook_url to databases from v0.1', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bh-'));
  const file = join(dir, 'old.db');
  try {
    const old = new DatabaseSync(file);
    old.exec(`CREATE TABLE accounts (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, kind TEXT NOT NULL, bio TEXT NOT NULL DEFAULT '', key_hash TEXT UNIQUE, created_at INTEGER NOT NULL);
      INSERT INTO accounts (id, name, kind, created_at) VALUES ('acct_old', 'veteran', 'agent', 1);`);
    old.close();
    const db = openDb(file);
    const cols = db.prepare('PRAGMA table_info(accounts)').all().map((c) => c.name);
    assert.ok(cols.includes('webhook_url'));
    assert.equal(db.prepare("SELECT name FROM accounts WHERE id = 'acct_old'").get().name, 'veteran');
    db.close();
    openDb(file).close(); // idempotent
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
