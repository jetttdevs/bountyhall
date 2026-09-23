// The house agent and the admin setup check, with a scripted stand-in for Claude.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';

const calls = { json: [], text: [] };
let claudeUp = true;
const ask = {
  async json({ user }) {
    calls.json.push(user);
    if (!claudeUp) return null;
    const physical = /repaint|in person|call my/i.test(user);
    return { can_deliver: !physical, pitch: physical ? 'no' : 'Crisp copy, delivered in one go.', eta_hours: 3 };
  },
  async text({ user }) {
    calls.text.push(user);
    if (!claudeUp) return null;
    return { text: `# Delivery\n\nWork for: ${user.match(/Title: (.*)/)[1]}`, model: 'fake' };
  },
};

let app, base;
before(async () => {
  process.env.ADMIN_TOKEN = 'a-very-long-admin-token-for-tests-123';
  process.env.SIGNUP_PER_HOUR = '1000';
  app = createApp({ dbFile: ':memory:', sweepMs: 0, house: { ask, intervalMs: 0 } });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});
after(() => { app.server.closeAllConnections(); app.server.close(); });

async function call(method, path, { key, body } = {}) {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}
const ok = async (p) => { const r = await p; assert.ok(r.status < 300, `got ${r.status}: ${JSON.stringify(r.data)}`); return r.data; };
const admin = (method, path, body) => call(method, path, { key: process.env.ADMIN_TOKEN, body });

test('the house agent bids on what it can deliver, passes on the rest, and delivers when it wins', async () => {
  const house = await ok(call('GET', '/api/accounts/house-agent'));
  assert.equal(house.kind, 'agent');
  const o = await ok(call('POST', '/api/accounts', { body: { name: 'hposter', kind: 'human' } }));
  const key = o.api_key;
  const copy = await ok(call('POST', '/api/intents', { key, body: { title: 'Five taglines for a bakery', body: 'Short and warm, no puns.', budget: 100 } }));
  const paint = await ok(call('POST', '/api/intents', { key, body: { title: 'Repaint my fence', body: 'Come repaint it in person this weekend.', budget: 200 } }));

  const r1 = await app.houseTick();
  assert.deepEqual([r1.bids, r1.passes], [1, 1]);
  const seen = await ok(call('GET', `/api/intents/${copy.id}`, { key }));
  const bid = seen.bids.find((b) => b.solver_name === 'house-agent');
  assert.equal(bid.price, 80, 'bids 80% of the budget by default');
  assert.equal(bid.eta_hours, 3);
  assert.match(bid.pitch, /Crisp copy/);
  assert.equal((await ok(call('GET', `/api/intents/${paint.id}`, { key }))).bids.length, 0);

  // decisions stick: no second triage for the same intents
  const before = calls.json.length;
  const r2 = await app.houseTick();
  assert.deepEqual([r2.bids, r2.passes, calls.json.length], [0, 0, before]);

  // the task text reaches Claude wrapped as data
  assert.match(calls.json[0], /^<task>/);

  await ok(call('POST', `/api/intents/${copy.id}/award`, { key, body: { bid_id: bid.id } }));
  const r3 = await app.houseTick();
  assert.equal(r3.deliveries, 1);
  const delivered = await ok(call('GET', `/api/intents/${copy.id}`, { key }));
  assert.equal(delivered.status, 'delivered');
  assert.match(delivered.delivery.content, /Work for: Five taglines for a bakery/);
  await ok(call('POST', `/api/intents/${copy.id}/accept`, { key, body: { rating: 5 } }));
  assert.equal((await ok(call('GET', '/api/accounts/house-agent'))).reputation.earned, 78);
});

test('when Claude is unavailable the house agent retries later instead of giving up', async () => {
  const o = await ok(call('POST', '/api/accounts', { body: { name: 'hposter2', kind: 'human' } }));
  const i = await ok(call('POST', '/api/intents', { key: o.api_key, body: { title: 'A product description', body: 'For a ceramic mug, 80 words.', budget: 50 } }));
  claudeUp = false;
  const r = await app.houseTick();
  assert.deepEqual([r.bids, r.passes], [0, 0]);
  claudeUp = true;
  assert.equal((await app.houseTick()).bids, 1);
  const seen = await ok(call('GET', `/api/intents/${i.id}`, { key: o.api_key }));
  const bid = seen.bids[0];
  await ok(call('POST', `/api/intents/${i.id}/award`, { key: o.api_key, body: { bid_id: bid.id } }));
  claudeUp = false;
  assert.equal((await app.houseTick()).deliveries, 0);
  claudeUp = true;
  assert.equal((await app.houseTick()).deliveries, 1);
});

test('admin: house tick endpoint and the setup check', async () => {
  assert.equal((await call('POST', '/api/admin/house/tick')).status, 401);
  const r = await ok(admin('POST', '/api/admin/house/tick'));
  assert.ok('bids' in r);
  assert.equal((await call('GET', '/api/admin/health')).status, 401);
  const h = await ok(admin('GET', '/api/admin/health'));
  assert.match(h.version, /^\d+\.\d+\.\d+$/);
  const byName = Object.fromEntries(h.checks.map((c) => [c.item, c]));
  assert.equal(byName['Admin token'].level, 'ok');
  assert.equal(byName['House agent'].level, 'ok');
  assert.equal(byName.Database.level, 'warn', 'an in-memory database is flagged');
  assert.equal(byName.Payments.level, 'ok');
  assert.equal((await ok(call('GET', '/api/stats'))).house_agent, 'house-agent');
  const html = await (await fetch(base + '/admin')).text();
  assert.match(html, /Admin token/);
});
