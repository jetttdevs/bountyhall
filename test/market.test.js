// End-to-end tests over real HTTP against an in-memory database.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey, verify } from 'node:crypto';
import { createApp } from '../src/server.js';
import { advanceClock, resetClock, HOUR, MINUTE } from '../src/util.js';

let app, base;
const judgeCalls = [];
let judgeReply = null;

before(async () => {
  process.env.ADMIN_TOKEN = 'admin-secret';
  process.env.SIGNUP_PER_HOUR = '1000';
  app = createApp({ dbFile: ':memory:', sweepMs: 0, judge: async (c) => { judgeCalls.push(c); return judgeReply; } });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});
after(() => { resetClock(); app.server.closeAllConnections(); app.server.close(); });

async function call(method, path, { key, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers.Authorization = `Bearer ${key}`;
  const res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}
const ok = async (p) => { const r = await p; assert.ok(r.status < 300, `expected success, got ${r.status}: ${JSON.stringify(r.data)}`); return r.data; };
const fails = async (p, status, code) => { const r = await p; assert.equal(r.status, status, JSON.stringify(r.data)); if (code) assert.equal(r.data.code, code); return r.data; };

let n = 0;
async function signup(kind = 'agent') {
  const out = await ok(call('POST', '/api/accounts', { body: { name: `${kind}${++n}`, kind, bio: 'test' } }));
  return { ...out.account, key: out.api_key };
}
const balance = async (u) => (await ok(call('GET', '/api/me', { key: u.key }))).balance;
const intentBody = (extra = {}) => ({ title: 'Write a haiku about escrow', body: 'Three lines, 5-7-5, about money waiting patiently.', budget: 200, tags: ['Poetry', 'writing'], ...extra });
const ledgerBalanced = () => assert.equal(app.market.ledgerTotal(), 0, 'ledger must always sum to zero');

test('accounts: signup, auth, validation, duplicate names', async () => {
  const u = await signup('human');
  assert.match(u.key, /^bh_/);
  assert.equal(u.balance, 1000);
  await fails(call('GET', '/api/me'), 401, 'unauthorized');
  await fails(call('GET', '/api/me', { key: 'bh_nope' }), 401);
  await fails(call('POST', '/api/accounts', { body: { name: u.name, kind: 'agent' } }), 409, 'name_taken');
  await fails(call('POST', '/api/accounts', { body: { name: 'x', kind: 'agent' } }), 400);
  await fails(call('POST', '/api/accounts', { body: { name: 'bad name!', kind: 'agent' } }), 400);
  await fails(call('POST', '/api/accounts', { body: { name: 'robot9', kind: 'alien' } }), 400);
  const prof = await ok(call('GET', `/api/accounts/${u.name}`));
  assert.equal(prof.name, u.name);
  assert.equal(prof.key_hash, undefined, 'never leak key hashes');
  ledgerBalanced();
});

test('happy path: post → sealed bids → award → deliver → accept → signed receipt', async () => {
  const poster = await signup('human');
  const a = await signup(); const b = await signup(); const outsider = await signup();
  const intent = await ok(call('POST', '/api/intents', { key: poster.key, body: intentBody() }));
  assert.equal(intent.status, 'open');
  assert.deepEqual(intent.tags, ['poetry', 'writing']);
  assert.equal(await balance(poster), 800, 'budget is escrowed');

  await fails(call('POST', `/api/intents/${intent.id}/bids`, { key: poster.key, body: { price: 10, eta_hours: 1, pitch: 'bidding on my own thing' } }), 403);
  await fails(call('POST', `/api/intents/${intent.id}/bids`, { key: a.key, body: { price: 999, eta_hours: 1, pitch: 'too expensive bid here' } }), 400);
  const bidA = await ok(call('POST', `/api/intents/${intent.id}/bids`, { key: a.key, body: { price: 150, eta_hours: 2, pitch: 'I write tight, vivid haiku.' } }));
  await ok(call('POST', `/api/intents/${intent.id}/bids`, { key: b.key, body: { price: 120, eta_hours: 3, pitch: 'Cheaper, still great haiku.' } }));
  // re-bidding updates in place
  await ok(call('POST', `/api/intents/${intent.id}/bids`, { key: a.key, body: { price: 140, eta_hours: 2, pitch: 'I write tight, vivid haiku. Now cheaper.' } }));

  // sealed: solvers only see their own bid, the public sees none
  const asA = await ok(call('GET', `/api/intents/${intent.id}`, { key: a.key }));
  assert.equal(asA.bids, undefined);
  assert.equal(asA.my_bid.price, 140);
  const asPublic = await ok(call('GET', `/api/intents/${intent.id}`));
  assert.equal(asPublic.bids, undefined); assert.equal(asPublic.my_bid, undefined);
  assert.equal(asPublic.bid_count, 2);
  const asPoster = await ok(call('GET', `/api/intents/${intent.id}`, { key: poster.key }));
  assert.equal(asPoster.bids.length, 2);
  assert.equal(asPoster.bids[0].price, 120, 'poster sees bids sorted by price');

  await fails(call('POST', `/api/intents/${intent.id}/award`, { key: a.key, body: { bid_id: bidA.id } }), 403);
  const awarded = await ok(call('POST', `/api/intents/${intent.id}/award`, { key: poster.key, body: { bid_id: bidA.id } }));
  assert.equal(awarded.status, 'awarded');
  assert.equal(awarded.winner.solver_id, a.id);
  assert.equal(await balance(poster), 860, 'unused budget refunded on award');
  await fails(call('POST', `/api/intents/${intent.id}/bids`, { key: outsider.key, body: { price: 5, eta_hours: 1, pitch: 'late bid should fail' } }), 409, 'bidding_closed');

  await fails(call('POST', `/api/intents/${intent.id}/deliver`, { key: b.key, body: { content: 'not mine to deliver' } }), 403);
  await fails(call('POST', `/api/intents/${intent.id}/accept`, { key: poster.key, body: {} }), 409, 'invalid_state');
  await ok(call('POST', `/api/intents/${intent.id}/deliver`, { key: a.key, body: { content: 'Coins wait in the dark\nuntil the work is finished\nthen they walk to you' } }));

  // delivery is private until settled
  const pub = await ok(call('GET', `/api/intents/${intent.id}`));
  assert.equal(pub.delivery.hidden, true);
  assert.equal((await ok(call('GET', `/api/intents/${intent.id}`, { key: poster.key }))).delivery.content.includes('Coins'), true);

  const done = await ok(call('POST', `/api/intents/${intent.id}/accept`, { key: poster.key, body: { rating: 5 } }));
  assert.equal(done.status, 'completed');
  assert.equal(done.solver_share, 100);
  // fee: 140 * 2.5% = 3.5 → 3
  assert.equal(await balance(a), 1000 + 137);
  assert.equal(await balance(poster), 860);
  assert.equal(await balance(b), 1000);
  assert.equal((await ok(call('GET', `/api/intents/${intent.id}`))).delivery.content.includes('Coins'), true, 'public after completion');

  const receipt = await ok(call('GET', `/api/receipts/${done.receipt}`));
  const wk = await ok(call('GET', '/.well-known/bountyhall.json'));
  assert.equal(wk.receipt_signing.public_key_spki_base64, receipt.public_key_spki_base64);
  const pub64 = createPublicKey({ key: Buffer.from(wk.receipt_signing.public_key_spki_base64, 'base64'), format: 'der', type: 'spki' });
  assert.ok(verify(null, Buffer.from(receipt.payload), pub64, Buffer.from(receipt.signature, 'base64')), 'receipt signature verifies');
  assert.ok(!verify(null, Buffer.from(receipt.payload.replace('"to_solver":137', '"to_solver":999')), pub64, Buffer.from(receipt.signature, 'base64')), 'tampered receipt fails');
  const payload = JSON.parse(receipt.payload);
  assert.equal(payload.to_solver, 137); assert.equal(payload.fee, 3); assert.equal(payload.refund, 0);

  const prof = await ok(call('GET', `/api/accounts/${a.name}`));
  assert.equal(prof.reputation.jobs, 1); assert.equal(prof.reputation.earned, 137); assert.equal(prof.reputation.avg_rating, 5);
  assert.equal((await ok(call('GET', '/api/stats'))).paid_out, 137);
  const board = await ok(call('GET', '/api/leaderboard'));
  assert.equal(board.agents[0].name, a.name);
  ledgerBalanced();
});

test('insufficient funds and input validation on intents', async () => {
  const poster = await signup('human');
  await fails(call('POST', '/api/intents', { key: poster.key, body: intentBody({ budget: 5000 }) }), 402, 'insufficient_funds');
  await fails(call('POST', '/api/intents', { key: poster.key, body: intentBody({ title: 'no' }) }), 400);
  await fails(call('POST', '/api/intents', { key: poster.key, body: intentBody({ budget: 'lots' }) }), 400);
  await fails(call('GET', '/api/intents/int_missing'), 404);
  const r = await fetch(base + '/api/intents', { method: 'POST', headers: { Authorization: `Bearer ${poster.key}`, 'Content-Type': 'application/json' }, body: '{not json' });
  assert.equal(r.status, 400);
  assert.equal(await balance(poster), 1000);
  ledgerBalanced();
});

test('cancel refunds; withdrawn bids disappear', async () => {
  const poster = await signup('human'); const a = await signup();
  const i = await ok(call('POST', '/api/intents', { key: poster.key, body: intentBody({ budget: 300 }) }));
  await ok(call('POST', `/api/intents/${i.id}/bids`, { key: a.key, body: { price: 100, eta_hours: 1, pitch: 'a bid I will withdraw' } }));
  await ok(call('DELETE', `/api/intents/${i.id}/bids`, { key: a.key }));
  assert.equal((await ok(call('GET', `/api/intents/${i.id}`, { key: poster.key }))).bids.length, 0);
  await fails(call('POST', `/api/intents/${i.id}/cancel`, { key: a.key }), 403);
  const c = await ok(call('POST', `/api/intents/${i.id}/cancel`, { key: poster.key }));
  assert.equal(c.status, 'cancelled');
  assert.equal(await balance(poster), 1000);
  ledgerBalanced();
});

test('dispute: Claude judge splits escrow when it returns a verdict', async () => {
  const poster = await signup('human'); const a = await signup();
  const i = await ok(call('POST', '/api/intents', { key: poster.key, body: intentBody({ budget: 100 }) }));
  await ok(call('POST', `/api/intents/${i.id}/bids`, { key: a.key, body: { price: 100, eta_hours: 1, pitch: 'full haiku, guaranteed' } }));
  await ok(call('POST', `/api/intents/${i.id}/award`, { key: poster.key, body: {} }));
  await ok(call('POST', `/api/intents/${i.id}/deliver`, { key: a.key, body: { content: 'only two lines\nof the haiku' } }));
  judgeReply = { solver_share: 40, rationale: 'Two of three lines were delivered.', judge: 'claude:test' };
  await fails(call('POST', `/api/intents/${i.id}/reject`, { key: poster.key, body: { reason: 'short' } }), 400);
  const d = await ok(call('POST', `/api/intents/${i.id}/reject`, { key: poster.key, body: { reason: 'It is missing the third line entirely.' } }));
  assert.equal(d.status, 'disputed');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(judgeCalls.at(-1).reason, 'It is missing the third line entirely.');
  assert.equal(judgeCalls.at(-1).delivery, 'only two lines\nof the haiku');
  const after = await ok(call('GET', `/api/intents/${i.id}`));
  assert.equal(after.status, 'resolved');
  assert.equal(after.verdict.solver_share, 40);
  assert.equal(after.verdict.judge, 'claude:test');
  // 40 gross, fee 1, solver 39, refund 60
  assert.equal(await balance(a), 1039);
  assert.equal(await balance(poster), 960);
  judgeReply = null;
  ledgerBalanced();
});

test('dispute: falls back to an admin ruling when no judge is available', async () => {
  const poster = await signup('human'); const a = await signup();
  const i = await ok(call('POST', '/api/intents', { key: poster.key, body: intentBody({ budget: 100 }) }));
  await ok(call('POST', `/api/intents/${i.id}/bids`, { key: a.key, body: { price: 80, eta_hours: 1, pitch: 'full haiku, guaranteed' } }));
  await ok(call('POST', `/api/intents/${i.id}/award`, { key: poster.key, body: {} }));
  await ok(call('POST', `/api/intents/${i.id}/deliver`, { key: a.key, body: { content: 'something off-topic' } }));
  await ok(call('POST', `/api/intents/${i.id}/reject`, { key: poster.key, body: { reason: 'This is not a haiku at all.' } }));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal((await ok(call('GET', `/api/intents/${i.id}`))).status, 'disputed');
  await fails(call('POST', `/api/admin/resolve/${i.id}`, { key: 'wrong', body: { solver_share: 0, rationale: 'x' } }), 401);
  const r = await ok(call('POST', `/api/admin/resolve/${i.id}`, { key: 'admin-secret', body: { solver_share: 0, rationale: 'Off-topic delivery.' } }));
  assert.equal(r.status, 'resolved');
  assert.equal(await balance(a), 1000);
  assert.equal(await balance(poster), 1000);
  assert.ok((await ok(call('GET', `/api/accounts/${a.name}`))).reputation.score < 0.7, 'reputation drops after a zero-share verdict');
  ledgerBalanced();
});

test('time: auto-award, expiry, missed deadlines and review timeout', async () => {
  const poster = await signup('human'); const cheap = await signup(); const pricey = await signup();
  // auto-award picks the better price/reputation mix once bidding closes
  const auto = await ok(call('POST', '/api/intents', { key: poster.key, body: intentBody({ budget: 100, bid_window_minutes: 5, auto_award: true }) }));
  await ok(call('POST', `/api/intents/${auto.id}/bids`, { key: pricey.key, body: { price: 95, eta_hours: 1, pitch: 'premium haiku service' } }));
  await ok(call('POST', `/api/intents/${auto.id}/bids`, { key: cheap.key, body: { price: 50, eta_hours: 2, pitch: 'budget haiku service' } }));
  // nobody bids on this one
  const lonely = await ok(call('POST', '/api/intents', { key: poster.key, body: intentBody({ budget: 70, bid_window_minutes: 5 }) }));
  advanceClock(6 * MINUTE);
  await fails(call('POST', `/api/intents/${auto.id}/bids`, { key: pricey.key, body: { price: 90, eta_hours: 1, pitch: 'after the deadline' } }), 409);
  app.market.sweep();
  const a1 = await ok(call('GET', `/api/intents/${auto.id}`));
  assert.equal(a1.status, 'awarded');
  assert.equal(a1.winner.solver_id, cheap.id);
  assert.equal((await ok(call('GET', `/api/intents/${lonely.id}`))).status, 'expired');
  assert.equal(await balance(poster), 1000 - 50, 'expired budget and unused auto-award budget refunded');

  // winner misses the 2h ETA → failed, full refund
  advanceClock(2 * HOUR + MINUTE);
  app.market.sweep();
  assert.equal((await ok(call('GET', `/api/intents/${auto.id}`))).status, 'failed');
  assert.equal(await balance(poster), 1000);
  const rep = (await ok(call('GET', `/api/accounts/${cheap.name}`))).reputation;
  assert.equal(rep.failed, 1);

  // delivered but never reviewed → auto-accepted after the review window
  const i = await ok(call('POST', '/api/intents', { key: poster.key, body: intentBody({ budget: 100 }) }));
  await ok(call('POST', `/api/intents/${i.id}/bids`, { key: pricey.key, body: { price: 100, eta_hours: 5, pitch: 'premium haiku service' } }));
  await ok(call('POST', `/api/intents/${i.id}/award`, { key: poster.key, body: {} }));
  await ok(call('POST', `/api/intents/${i.id}/deliver`, { key: pricey.key, body: { content: 'a patient haiku' } }));
  advanceClock(25 * HOUR);
  app.market.sweep();
  const settled = await ok(call('GET', `/api/intents/${i.id}`));
  assert.equal(settled.status, 'completed');
  assert.equal(settled.verdict.judge, 'timeout');
  assert.equal(await balance(pricey), 1000 + 98);
  resetClock();
  ledgerBalanced();
});

test('subcontracting: only the winner can post children, and must settle them first', async () => {
  const poster = await signup('human'); const prime = await signup(); const sub = await signup(); const rando = await signup();
  const parent = await ok(call('POST', '/api/intents', { key: poster.key, body: intentBody({ budget: 400, title: 'Launch kit: copy and logo' }) }));
  await ok(call('POST', `/api/intents/${parent.id}/bids`, { key: prime.key, body: { price: 400, eta_hours: 10, pitch: 'I will coordinate copy and logo' } }));
  await fails(call('POST', '/api/intents', { key: prime.key, body: intentBody({ parent_id: parent.id }) }), 403, 'forbidden');
  await ok(call('POST', `/api/intents/${parent.id}/award`, { key: poster.key, body: {} }));
  await fails(call('POST', '/api/intents', { key: rando.key, body: intentBody({ parent_id: parent.id }) }), 403);
  const child = await ok(call('POST', '/api/intents', { key: prime.key, body: intentBody({ parent_id: parent.id, title: 'Logo for the launch kit', budget: 150 }) }));
  assert.equal(child.parent_id, parent.id);
  await fails(call('POST', `/api/intents/${parent.id}/deliver`, { key: prime.key, body: { content: 'too early' } }), 409);
  await ok(call('POST', `/api/intents/${child.id}/bids`, { key: sub.key, body: { price: 150, eta_hours: 2, pitch: 'I draw clean logos' } }));
  await ok(call('POST', `/api/intents/${child.id}/award`, { key: prime.key, body: {} }));
  await ok(call('POST', `/api/intents/${child.id}/deliver`, { key: sub.key, body: { content: '<svg>logo</svg>' } }));
  await ok(call('POST', `/api/intents/${child.id}/accept`, { key: prime.key, body: { rating: 4 } }));
  await ok(call('POST', `/api/intents/${parent.id}/deliver`, { key: prime.key, body: { content: 'copy + <svg>logo</svg>' } }));
  await ok(call('POST', `/api/intents/${parent.id}/accept`, { key: poster.key, body: {} }));
  assert.equal(await balance(sub), 1000 + 147);
  assert.equal(await balance(prime), 1000 - 150 + 390);
  const p = await ok(call('GET', `/api/intents/${parent.id}`));
  assert.equal(p.children.length, 1);
  ledgerBalanced();
});

test('pages render, events flow, SSE streams, docs are served', async () => {
  for (const path of ['/', '/intents', '/intents?status=done', '/agents', '/post', '/join', '/me', '/docs']) {
    const r = await fetch(base + path);
    assert.equal(r.status, 200, path);
    assert.match(await r.text(), /Bountyhall/);
  }
  const list = await ok(call('GET', '/api/intents?status=done'));
  assert.ok(list.intents.length > 0);
  const page = await fetch(`${base}/i/${list.intents[0].id}`);
  assert.equal(page.status, 200);
  assert.equal((await fetch(`${base}/i/int_nope`)).status, 404);
  assert.equal((await fetch(`${base}/u/nobody-here`)).status, 404);
  const md = await (await fetch(`${base}/solver.md`)).text();
  assert.match(md, /solver guide/);
  assert.match(md, new RegExp(base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  assert.equal((await fetch(`${base}/styles.css`)).status, 200);
  const ev = await ok(call('GET', '/api/events?limit=5'));
  assert.equal(ev.events.length, 5);
  const stats = await ok(call('GET', '/api/stats'));
  assert.equal(stats.in_escrow >= 0, true);
  await fails(call('GET', '/api/nope'), 404);
  await fails(call('PUT', '/api/intents'), 405);

  // SSE: open a stream, cause an event, see it arrive
  const ctrl = new AbortController();
  const res = await fetch(`${base}/api/stream`, { signal: ctrl.signal });
  const reader = res.body.getReader();
  const got = (async () => {
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return buf;
      buf += new TextDecoder().decode(value);
      if (buf.includes('account.joined')) return buf;
    }
  })();
  await signup();
  const text = await got;
  ctrl.abort();
  assert.match(text, /event: market/);
});

test('bid.placed events never reveal prices (sealed bids)', async () => {
  const bidEvents = app.market.events({ limit: 200 }).filter((e) => e.type === 'bid.placed');
  assert.ok(bidEvents.length > 0);
  for (const e of bidEvents) assert.equal(e.data.price, undefined);
});
