// Token payments against an in-memory chain that follows the same interface as
// src/chain.js. Wallet signatures are real (viem accounts); only the chain is fake.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { verifyMessage, getAddress, keccak256, toHex } from 'viem';
import { createApp } from '../src/server.js';
import { advanceClock, resetClock, MINUTE } from '../src/util.js';

const DEC = 18n;
const UNIT = 10n ** DEC;
const TREASURY = getAddress('0x00000000000000000000000000000000000b0077');

class FakeChain {
  constructor() {
    this.treasury = TREASURY; this.token = getAddress('0x91a2dae9699f0b82540b5886b0d8759c22820ba3'); this.canSend = true;
    this.block = 1000n; this.logs = []; this.balance = 0n; this.gas = 10n ** 17n;
    this.mempool = new Map(); this.receipts = new Map(); this.minedNonce = 0; this.nextNonce = 0; this.sent = [];
    this.failBroadcast = false; this.revertNext = false; this.down = false;
  }
  async check() { if (this.down) throw new Error('rpc down'); return { chainId: 4663, decimals: Number(DEC), symbol: 'MUSEBOOK' }; }
  async head() { if (this.down) throw new Error('rpc down'); return this.block; }
  async transfersTo(from, to) { return this.logs.filter((l) => l.blockNumber >= from && l.blockNumber <= to); }
  deposit(from, whole, { raw } = {}) {
    const value = raw ?? BigInt(whole) * UNIT;
    this.block += 1n;
    const log = { txHash: keccak256(toHex(`dep${this.logs.length}${Math.random()}`)), logIndex: 0, blockNumber: this.block, from: getAddress(from), to: TREASURY, value };
    this.logs.push(log); this.balance += value;
    return log;
  }
  mine(n = 1) { this.block += BigInt(n); }
  async signTransfer(to, raw) {
    const nonce = this.nextNonce++;
    const rawTx = toHex(`tx:${to}:${raw}:${nonce}`);
    return { hash: keccak256(rawTx), raw: rawTx, nonce, to, amount: raw };
  }
  async broadcast(raw) {
    if (this.failBroadcast) throw new Error('rpc timeout');
    const [, to, amount, nonce] = Buffer.from(raw.slice(2), 'hex').toString().split(':');
    const hash = keccak256(raw);
    this.mempool.set(hash, { to, amount: BigInt(amount), nonce: Number(nonce) });
    return hash;
  }
  mineMempool() {
    this.block += 1n;
    for (const [hash, t] of this.mempool) {
      const status = this.revertNext ? 'reverted' : 'success';
      this.revertNext = false;
      if (status === 'success') { this.balance -= t.amount; this.sent.push(t); }
      this.receipts.set(hash, { status, blockNumber: this.block });
      this.minedNonce = Math.max(this.minedNonce, t.nonce + 1);
    }
    this.mempool.clear();
  }
  async receipt(hash) { return this.receipts.get(hash) || null; }
  async txExists(hash) { return this.mempool.has(hash) || this.receipts.has(hash); }
  async confirmedNonce() { return this.minedNonce; }
  async tokenBalance() { return this.balance; }
  async nativeBalance() { return this.gas; }
  verify(address, message, signature) { return verifyMessage({ address, message, signature }); }
}

const CONFIRMATIONS = 5;
let app, base, chain;
before(async () => {
  process.env.ADMIN_TOKEN = 'admin-secret';
  process.env.SIGNUP_PER_HOUR = '1000';
  chain = new FakeChain();
  app = createApp({
    dbFile: ':memory:', sweepMs: 0, judge: async () => null,
    payments: { chain, pollMs: 0, config: { mode: 'token', chainId: 4663, chainName: 'Robinhood Chain', symbol: 'MUSEBOOK', rpcUrl: 'http://rpc.invalid', explorer: 'https://explorer.test', confirmations: CONFIRMATIONS, minWithdrawal: 100, fromBlock: null } },
  });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  await app.payments.poll(); // init + set the cursor at the current safe head
});
after(() => { resetClock(); app.server.closeAllConnections(); app.server.close(); });

async function call(method, path, { key, body } = {}) {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}
const ok = async (p) => { const r = await p; assert.ok(r.status < 300, `got ${r.status}: ${JSON.stringify(r.data)}`); return r.data; };
const fails = async (p, status, code) => { const r = await p; assert.equal(r.status, status, JSON.stringify(r.data)); if (code) assert.equal(r.data.code, code); return r.data; };
const adminCall = (method, path, body) => call(method, path, { key: 'admin-secret', body });
let n = 0;
async function signup(kind = 'agent') {
  const o = await ok(call('POST', '/api/accounts', { body: { name: `p${kind}${++n}`, kind } }));
  return { ...o.account, key: o.api_key, wallet: privateKeyToAccount(generatePrivateKey()) };
}
async function link(user, wallet = user.wallet) {
  const ch = await ok(call('GET', `/api/wallet/challenge?address=${wallet.address}`, { key: user.key }));
  const signature = await wallet.signMessage({ message: ch.message });
  return ok(call('POST', '/api/wallet/link', { key: user.key, body: { address: wallet.address, signature } }));
}
const balance = async (u) => (await ok(call('GET', '/api/me', { key: u.key }))).balance;
const settle = async () => { chain.mine(CONFIRMATIONS + 1); await app.payments.poll(); };
const solvent = async () => { const t = await ok(adminCall('GET', '/api/admin/treasury')); assert.equal(t.solvent, true, JSON.stringify(t)); assert.equal(app.market.ledgerTotal(), 0); return t; };

test('token mode: public config, no free credits, token label on the site', async () => {
  const cfg = await ok(call('GET', '/api/payments'));
  assert.equal(cfg.mode, 'token');
  assert.equal(cfg.symbol, 'MUSEBOOK');
  assert.equal(cfg.chain_id, 4663);
  assert.equal(cfg.deposit_address, TREASURY);
  assert.equal(cfg.decimals, 18);
  assert.equal(cfg.ready, true);
  const u = await signup('human');
  assert.equal(u.balance, 0, 'no unbacked signup credits in token mode');
  await fails(call('POST', '/api/intents', { key: u.key, body: { title: 'Needs money', body: 'This should fail without a deposit.', budget: 10 } }), 402);
  const html = await (await fetch(base + '/')).text();
  assert.match(html, /MUSEBOOK in escrow/);
  assert.match(html, /href="\/wallet"/);
  const wallet = await (await fetch(base + '/wallet')).text();
  assert.match(wallet, /Robinhood Chain/);
  assert.match(wallet, new RegExp(TREASURY));
  const wk = await ok(call('GET', '/.well-known/bountyhall.json'));
  assert.equal(wk.payments.token, chain.token);
});

test('wallet linking: signatures, single-use challenges, one account per wallet', async () => {
  const a = await signup('human'); const b = await signup('human');
  await fails(call('GET', '/api/wallet/challenge?address=nope', { key: a.key }), 400);
  await fails(call('POST', '/api/wallet/link', { key: a.key, body: { address: a.wallet.address, signature: '0x1234' } }), 400, 'no_challenge');
  // signed by the wrong key
  const ch = await ok(call('GET', `/api/wallet/challenge?address=${a.wallet.address}`, { key: a.key }));
  assert.match(ch.message, /Bountyhall wallet link/);
  assert.match(ch.message, new RegExp(a.wallet.address));
  const forged = await b.wallet.signMessage({ message: ch.message });
  await fails(call('POST', '/api/wallet/link', { key: a.key, body: { address: a.wallet.address, signature: forged } }), 400, 'bad_signature');
  // the challenge was spent by the failed attempt
  const good = await a.wallet.signMessage({ message: ch.message });
  await fails(call('POST', '/api/wallet/link', { key: a.key, body: { address: a.wallet.address, signature: good } }), 400, 'no_challenge');
  // expired challenge
  const ch2 = await ok(call('GET', `/api/wallet/challenge?address=${a.wallet.address}`, { key: a.key }));
  advanceClock(11 * MINUTE);
  await fails(call('POST', '/api/wallet/link', { key: a.key, body: { address: a.wallet.address, signature: await a.wallet.signMessage({ message: ch2.message }) } }), 400, 'challenge_expired');
  resetClock();
  const linked = await link(a);
  assert.equal(linked.address, a.wallet.address);
  // lowercase address still resolves to the same wallet
  const w = await ok(call('GET', '/api/wallet', { key: a.key }));
  assert.equal(w.wallet.address, a.wallet.address);
  // b cannot link a's wallet, even with a valid signature from it
  const ch3 = await ok(call('GET', `/api/wallet/challenge?address=${a.wallet.address.toLowerCase()}`, { key: b.key }));
  await fails(call('POST', '/api/wallet/link', { key: b.key, body: { address: a.wallet.address, signature: await a.wallet.signMessage({ message: ch3.message }) } }), 409, 'wallet_taken');
  await fails(call('GET', '/api/wallet'), 401);
});

test('deposits: credited only after confirmations, never twice, unclaimed until linked', async () => {
  const u = await signup('human');
  await link(u);
  const log = chain.deposit(u.wallet.address, 50_000);
  await app.payments.poll();
  assert.equal(await balance(u), 0, 'not credited before confirmations');
  await settle();
  assert.equal(await balance(u), 50_000);
  // the same log seen again (e.g. an overlapping scan) is ignored
  app.db.prepare("UPDATE meta SET v = ? WHERE k = 'chain_cursor'").run(String(log.blockNumber - 1n));
  await app.payments.poll();
  assert.equal(await balance(u), 50_000);
  // fractions of a token are not credited; pure dust is recorded as dust
  chain.deposit(u.wallet.address, 0, { raw: 7n * UNIT + UNIT / 2n });
  chain.deposit(u.wallet.address, 0, { raw: 12345n });
  await settle();
  assert.equal(await balance(u), 50_007);
  const w = await ok(call('GET', '/api/wallet', { key: u.key }));
  assert.equal(w.deposits.length, 2, 'dust is not attributed to the account');
  // a stranger sends tokens before linking: held, then claimed on link
  const late = await signup('human');
  chain.deposit(late.wallet.address, 900);
  await settle();
  assert.equal(await balance(late), 0);
  assert.equal((await ok(adminCall('GET', '/api/admin/treasury'))).unclaimed_deposits, 900);
  const linked = await link(late);
  assert.equal(linked.claimed_deposits, 1);
  assert.equal(linked.claimed_amount, 900);
  assert.equal(await balance(late), 900);
  await solvent();
});

test('a job paid in MUSEBOOK, withdrawn after admin approval', async () => {
  const poster = await signup('human'); const solver = await signup();
  await link(poster); await link(solver);
  chain.deposit(poster.wallet.address, 10_000);
  await settle();
  const i = await ok(call('POST', '/api/intents', { key: poster.key, body: { title: 'Logo in MUSEBOOK', body: 'A clean SVG logo, paid on-chain.', budget: 8_000 } }));
  const bid = await ok(call('POST', `/api/intents/${i.id}/bids`, { key: solver.key, body: { price: 6_000, eta_hours: 2, pitch: 'Clean SVG logo, two variants.' } }));
  await ok(call('POST', `/api/intents/${i.id}/award`, { key: poster.key, body: { bid_id: bid.id } }));
  await ok(call('POST', `/api/intents/${i.id}/deliver`, { key: solver.key, body: { content: '<svg/>' } }));
  await ok(call('POST', `/api/intents/${i.id}/accept`, { key: poster.key, body: { rating: 5 } }));
  assert.equal(await balance(solver), 5_850, '6000 minus the 2.5% fee');
  assert.equal(await balance(poster), 4_000);
  await solvent();

  // withdrawal rules
  const nobody = await signup();
  await fails(call('POST', '/api/wallet/withdraw', { key: nobody.key, body: { amount: 100 } }), 409, 'no_wallet');
  await fails(call('POST', '/api/wallet/withdraw', { key: solver.key, body: { amount: 50 } }), 400);
  await fails(call('POST', '/api/wallet/withdraw', { key: solver.key, body: { amount: 999_999 } }), 402);
  const w = await ok(call('POST', '/api/wallet/withdraw', { key: solver.key, body: { amount: 5_000 } }));
  assert.equal(w.status, 'pending');
  assert.equal(w.to_address, solver.wallet.address);
  assert.equal(await balance(solver), 850, 'held while pending');
  // cannot change wallets while a withdrawal is open
  const other = privateKeyToAccount(generatePrivateKey());
  const ch = await ok(call('GET', `/api/wallet/challenge?address=${other.address}`, { key: solver.key }));
  await fails(call('POST', '/api/wallet/link', { key: solver.key, body: { address: other.address, signature: await other.signMessage({ message: ch.message }) } }), 409, 'withdrawal_open');

  // admin only
  await fails(call('POST', `/api/admin/withdrawals/${w.id}/approve`, { key: solver.key }), 401);
  const queue = await ok(adminCall('GET', '/api/admin/withdrawals?status=pending'));
  assert.ok(queue.withdrawals.some((x) => x.id === w.id && x.account_balance === 850 && x.wallet_linked_at));
  const [first, second] = await Promise.all([adminCall('POST', `/api/admin/withdrawals/${w.id}/approve`), adminCall('POST', `/api/admin/withdrawals/${w.id}/approve`)]);
  assert.deepEqual([first.status, second.status].sort(), [200, 409], 'double approval sends once');
  const sending = (first.status === 200 ? first : second).data;
  assert.equal(sending.status, 'sending');
  assert.match(sending.tx_hash, /^0x[0-9a-f]{64}$/);
  assert.equal(chain.mempool.size, 1);
  const [t] = [...chain.mempool.values()];
  assert.equal(getAddress(t.to), solver.wallet.address);
  assert.equal(t.amount, 5_000n * UNIT, 'sends whole tokens scaled by decimals');
  chain.mineMempool();
  await app.payments.poll();
  assert.equal((await ok(call('GET', '/api/wallet', { key: solver.key }))).withdrawals[0].status, 'sending', 'waits for confirmations');
  await settle();
  const done = (await ok(call('GET', '/api/wallet', { key: solver.key }))).withdrawals[0];
  assert.equal(done.status, 'confirmed');
  assert.match(done.explorer_url, /^https:\/\/explorer\.test\/tx\/0x/);
  assert.equal(await balance(solver), 850);
  await solvent();
});

test('withdrawals: rejection, reverted transfers, dropped transfers and an empty hot wallet', async () => {
  const u = await signup(); await link(u);
  chain.deposit(u.wallet.address, 3_000);
  await settle();

  // rejected: money comes back
  const r = await ok(call('POST', '/api/wallet/withdraw', { key: u.key, body: { amount: 1_000 } }));
  await fails(adminCall('POST', `/api/admin/withdrawals/${r.id}/reject`, {}), 400);
  const rej = await ok(adminCall('POST', `/api/admin/withdrawals/${r.id}/reject`, { reason: 'Please verify on Discord first.' }));
  assert.equal(rej.status, 'rejected');
  assert.equal(await balance(u), 3_000);
  await fails(adminCall('POST', `/api/admin/withdrawals/${r.id}/approve`), 409);

  // reverted on-chain: refunded automatically
  const rv = await ok(call('POST', '/api/wallet/withdraw', { key: u.key, body: { amount: 500 } }));
  await ok(adminCall('POST', `/api/admin/withdrawals/${rv.id}/approve`));
  chain.revertNext = true; chain.mineMempool();
  await settle();
  assert.equal((await ok(adminCall('GET', '/api/admin/withdrawals'))).withdrawals.find((x) => x.id === rv.id).status, 'failed');
  assert.equal(await balance(u), 3_000);

  // broadcast fails: stays "sending"; refund refused while its nonce is unused
  chain.failBroadcast = true;
  const dr = await ok(call('POST', '/api/wallet/withdraw', { key: u.key, body: { amount: 700 } }));
  const s = await ok(adminCall('POST', `/api/admin/withdrawals/${dr.id}/approve`));
  assert.equal(s.status, 'sending');
  assert.match(s.error, /broadcast failed/);
  await fails(adminCall('POST', `/api/admin/withdrawals/${dr.id}/refund`), 409, 'nonce_unused');
  // rebroadcast works once the RPC is back
  chain.failBroadcast = false;
  const rb = await ok(adminCall('POST', `/api/admin/withdrawals/${dr.id}/rebroadcast`));
  assert.equal(rb.error, null);
  await fails(adminCall('POST', `/api/admin/withdrawals/${dr.id}/refund`), 409, 'still_pending');
  // the transfer drops out of the mempool and another transaction uses its nonce: now it can be refunded
  chain.mempool.clear();
  chain.minedNonce += 5;
  const refunded = await ok(adminCall('POST', `/api/admin/withdrawals/${dr.id}/refund`));
  assert.equal(refunded.status, 'refunded');
  assert.equal(await balance(u), 3_000);

  // hot wallet cannot cover it: nothing is signed, request goes back to pending
  const big = await signup(); await link(big);
  chain.deposit(big.wallet.address, 1_000);
  await settle();
  const saved = chain.balance; chain.balance = 10n * UNIT;
  const b = await ok(call('POST', '/api/wallet/withdraw', { key: big.key, body: { amount: 1_000 } }));
  await fails(adminCall('POST', `/api/admin/withdrawals/${b.id}/approve`), 502, 'send_failed');
  const back = (await ok(adminCall('GET', '/api/admin/withdrawals?status=pending'))).withdrawals.find((x) => x.id === b.id);
  assert.match(back.error, /hot wallet holds/);
  chain.balance = saved;
  await ok(adminCall('POST', `/api/admin/withdrawals/${b.id}/reject`, { reason: 'test cleanup' }));
  await solvent();
});

test('treasury report, chain outages and the admin desk page', async () => {
  const t = await ok(adminCall('GET', '/api/admin/treasury'));
  assert.equal(t.owed_total, t.held_by_users + t.in_escrow + t.fees + t.pending_withdrawals);
  assert.equal(t.surplus, t.onchain_balance - t.owed_total);
  assert.equal(t.unbacked_signup_credits, 0);
  await fails(call('GET', '/api/admin/treasury'), 401);
  // a missing token shows up as insolvency
  chain.balance -= 1_000_000n * UNIT;
  assert.equal((await ok(adminCall('GET', '/api/admin/treasury'))).solvent, false);
  chain.balance += 1_000_000n * UNIT;
  // RPC outage: polling reports the error and keeps state
  chain.down = true;
  const p = await app.payments.poll();
  assert.match(p.error, /rpc down/);
  chain.down = false;
  assert.equal((await app.payments.poll()).error, undefined);
  const html = await (await fetch(base + '/admin')).text();
  assert.match(html, /Admin token/);
  const disputes = await ok(adminCall('GET', '/api/admin/disputes'));
  assert.ok(Array.isArray(disputes.disputes));
});

test('credits mode keeps payments off', async () => {
  const plain = createApp({ dbFile: ':memory:', sweepMs: 0, payments: { config: { mode: 'credits' } } });
  await new Promise((r) => plain.server.listen(0, r));
  const b = `http://127.0.0.1:${plain.server.address().port}`;
  try {
    assert.equal((await (await fetch(b + '/api/payments')).json()).mode, 'credits');
    assert.equal((await fetch(b + '/api/wallet/challenge?address=0x0')).status, 404);
  } finally {
    plain.server.closeAllConnections(); plain.server.close();
    // restore the label for any later tests in this process
    (await import('../src/views.js')).setUnit('MUSEBOOK');
  }
});

test('agents: solver.md explains token payments, MCP exposes the wallet', async () => {
  const md = await (await fetch(base + '/solver.md')).text();
  assert.match(md, /## Payments in MUSEBOOK/);
  assert.match(md, new RegExp(TREASURY));
  assert.match(md, /signMessage/);
  assert.doesNotMatch(md, /free test credits/);
  const u = await signup(); await link(u);
  chain.deposit(u.wallet.address, 2_000);
  await settle();
  const rpc = async (name, args) => {
    const res = await fetch(base + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${u.key}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
    return (await res.json()).result;
  };
  const w = JSON.parse((await rpc('my_wallet', {})).content[0].text);
  assert.equal(w.balance, 2_000);
  assert.equal(w.wallet.address, u.wallet.address);
  assert.equal(w.config.symbol, 'MUSEBOOK');
  const req = await rpc('request_withdrawal', { amount: 1_500 });
  assert.equal(req.isError, false);
  assert.equal(JSON.parse(req.content[0].text).status, 'pending');
  const tooMuch = await rpc('request_withdrawal', { amount: 1_000 });
  assert.equal(tooMuch.isError, true);
  assert.match(tooMuch.content[0].text, /insufficient/);
  await ok(adminCall('POST', `/api/admin/withdrawals/${JSON.parse(req.content[0].text).id}/reject`, { reason: 'cleanup' }));
  await solvent();
});

test('a withdrawal interrupted mid-signing goes back to the queue on restart', async () => {
  const u = await signup(); await link(u);
  chain.deposit(u.wallet.address, 1_000);
  await settle();
  const w = await ok(call('POST', '/api/wallet/withdraw', { key: u.key, body: { amount: 1_000 } }));
  app.db.prepare("UPDATE withdrawals SET status = 'signing' WHERE id = ?").run(w.id); // simulate a crash
  await app.payments.init();
  const back = (await ok(adminCall('GET', '/api/admin/withdrawals?status=pending'))).withdrawals.find((x) => x.id === w.id);
  assert.match(back.error, /interrupted/);
  await ok(adminCall('POST', `/api/admin/withdrawals/${w.id}/reject`, { reason: 'cleanup' }));
  await solvent();
});

test('operator payouts of house fees, and the setup check in token mode', async () => {
  const t0 = await ok(adminCall('GET', '/api/admin/treasury'));
  assert.ok(t0.fees > 0, 'earlier jobs left house fees');
  const to = privateKeyToAccount(generatePrivateKey()).address;
  await fails(adminCall('POST', '/api/admin/payout', { source: 'nope', amount: 1, to }), 400);
  await fails(adminCall('POST', '/api/admin/payout', { source: 'fees', amount: t0.fees + 1, to }), 402);
  await fails(adminCall('POST', '/api/admin/payout', { source: 'fees', amount: 1, to: 'bad' }), 400);
  const p = await ok(adminCall('POST', '/api/admin/payout', { source: 'fees', amount: t0.fees, to }));
  assert.equal(p.note, 'operator payout');
  assert.equal(p.to_address, to);
  await ok(adminCall('POST', `/api/admin/withdrawals/${p.id}/approve`));
  chain.mineMempool();
  await settle();
  const t1 = await ok(adminCall('GET', '/api/admin/treasury'));
  assert.equal(t1.fees, 0);
  assert.equal(t1.owed_total, t0.owed_total - t0.fees, 'paying out fees reduces what the treasury owes');
  await solvent();
  const h = await ok(adminCall('GET', '/api/admin/health'));
  const byName = Object.fromEntries(h.checks.map((c) => [c.item, c]));
  assert.equal(byName['Chain connection'].level, 'ok');
  assert.equal(byName['Hot wallet key'].level, 'ok');
  assert.equal(byName.Solvency.level, 'ok');
  assert.equal(byName['RPC endpoint'].level, 'ok');
});

test('daily withdrawal limit per account', async () => {
  app.payments.cfg.maxWithdrawalPerDay = 1_500;
  try {
    const u = await signup(); await link(u);
    chain.deposit(u.wallet.address, 5_000);
    await settle();
    const a = await ok(call('POST', '/api/wallet/withdraw', { key: u.key, body: { amount: 1_000 } }));
    const over = await fails(call('POST', '/api/wallet/withdraw', { key: u.key, body: { amount: 600 } }), 429, 'daily_limit');
    assert.match(over.error, /500 left/);
    // a rejected request frees its share of the limit
    await ok(adminCall('POST', `/api/admin/withdrawals/${a.id}/reject`, { reason: 'test' }));
    const b = await ok(call('POST', '/api/wallet/withdraw', { key: u.key, body: { amount: 1_500 } }));
    await ok(adminCall('POST', `/api/admin/withdrawals/${b.id}/reject`, { reason: 'cleanup' }));
    await solvent();
  } finally {
    app.payments.cfg.maxWithdrawalPerDay = 0;
  }
});
