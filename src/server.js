// HTTP layer: JSON API, server-rendered pages, static files and a live SSE feed.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { openDb } from './db.js';
import { Market, SYS } from './market.js';
import { judgeDispute, judgeEnabled } from './judge.js';
import { HttpError, MINUTE } from './util.js';
import * as views from './views.js';
import { solverDoc } from './solver-doc.js';
import { handleRpc } from './mcp.js';
import { createDispatcher, validateWebhookUrl } from './webhooks.js';
import { Payments, paymentsConfigFromEnv } from './payments.js';
import { createChain } from './chain.js';
import { HouseAgent } from './house-agent.js';
import { claudeEnabled, MODEL } from './claude.js';

const VERSION = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')).version;
const STARTED = Date.now();

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STATIC = {
  '/styles.css': ['public/styles.css', 'text/css; charset=utf-8'],
  '/app.js': ['public/app.js', 'text/javascript; charset=utf-8'],
  '/favicon.svg': ['public/favicon.svg', 'image/svg+xml'],
};
const MAX_BODY = 64 * 1024;

// Fixed-window limiter keyed by string.
function limiter(max, windowMs) {
  const hits = new Map();
  return (key) => {
    const t = Date.now();
    const h = hits.get(key);
    if (!h || t - h.start >= windowMs) { hits.set(key, { start: t, n: 1 }); return true; }
    h.n++;
    if (hits.size > 10000) for (const [k, v] of hits) if (t - v.start >= windowMs) hits.delete(k);
    return h.n <= max;
  };
}

export function createApp({ dbFile, market: marketOpts = {}, sweepMs = 15000, judge = judgeDispute, webhooks = {}, payments: payOpts = {}, house: houseOpts = {} } = {}) {
  const dbPath = dbFile ?? process.env.BOUNTYHALL_DB ?? 'data/bountyhall.db';
  const db = openDb(dbPath);
  const payCfg = payOpts.config ?? paymentsConfigFromEnv();
  const tokenMode = payCfg.mode === 'token';
  // in token mode every credit must be backed by a deposit, so there is no signup faucet
  const market = new Market(db, tokenMode ? { ...marketOpts, signupCredits: 0 } : marketOpts);
  const payments = tokenMode ? new Payments(market, payOpts.chain ?? createChain(payCfg), payCfg) : null;
  views.setUnit(tokenMode ? payCfg.symbol : 'cr');
  const pollMs = payOpts.pollMs ?? Number(process.env.CHAIN_POLL_MS ?? 15000);
  const poller = payments && pollMs ? setInterval(() => payments.poll(), pollMs) : null;
  poller?.unref();
  if (payments && pollMs) payments.poll();

  // the house agent: on with HOUSE_AGENT=1 and a Claude key, or when a test passes its own `ask`
  const houseOn = houseOpts.ask ? true : houseOpts.enabled ?? (process.env.HOUSE_AGENT === '1' && claudeEnabled());
  const house = houseOn ? new HouseAgent(market, {
    name: process.env.HOUSE_AGENT_NAME || 'house-agent',
    maxBudget: Number(process.env.HOUSE_AGENT_MAX_BUDGET || Infinity),
    discount: Number(process.env.HOUSE_AGENT_DISCOUNT || 0.8),
    ...(houseOpts.ask ? { ask: houseOpts.ask } : {}),
  }) : null;
  const houseState = { last: null, at: null };
  const houseTick = async () => { houseState.last = await house.tick(); houseState.at = Date.now(); return houseState.last; };
  const houseMs = houseOpts.intervalMs ?? Number(process.env.HOUSE_AGENT_MS ?? 60000);
  const houseTimer = house && houseMs ? setInterval(() => houseTick().catch(() => {}), houseMs) : null;
  houseTimer?.unref();
  const adminToken = process.env.ADMIN_TOKEN || '';
  const signupLimit = limiter(Number(process.env.SIGNUP_PER_HOUR ?? 10), 60 * MINUTE);
  const writeLimit = limiter(Number(process.env.WRITES_PER_MINUTE ?? 60), MINUTE);
  const streams = new Set();

  const allowPrivateWebhooks = webhooks.allowPrivate ?? process.env.WEBHOOK_ALLOW_PRIVATE === '1';
  const dispatch = createDispatcher(market, { allowPrivate: allowPrivateWebhooks, ...webhooks });
  const webhookJobs = new Set();
  market.onEvent((ev) => {
    const job = dispatch(ev).finally(() => webhookJobs.delete(job));
    webhookJobs.add(job);
  });

  market.onEvent((ev) => {
    const line = `id: ${ev.seq}\nevent: market\ndata: ${JSON.stringify(ev)}\n\n`;
    for (const res of streams) res.write(line);
  });

  async function runJudge(intentId) {
    const verdict = await judge(market.disputeCase(intentId));
    if (!verdict) return;
    try { market.resolve(intentId, verdict); } catch (err) { if (!(err instanceof HttpError)) console.error(err); }
  }
  const startJudge = (intentId) => { runJudge(intentId).catch((e) => console.error('[judge]', e)); };

  const sweeper = sweepMs ? setInterval(() => { try { market.sweep(); } catch (e) { console.error('[sweep]', e); } }, sweepMs) : null;
  sweeper?.unref();

  // A configuration checklist for the admin desk: what works, what is missing.
  async function health() {
    const check = (item, ok, detail, level = 'error') => ({ item, ok: Boolean(ok), level: ok ? 'ok' : level, detail });
    const onVolume = dbPath === ':memory:' ? false : dbPath.startsWith('/app/data') || dbPath.startsWith('data/');
    const checks = [
      check('Admin token', adminToken.length >= 24, adminToken.length >= 24 ? 'set' : `only ${adminToken.length} characters; use a long random value`, 'warn'),
      check('Public URL', process.env.PUBLIC_URL, process.env.PUBLIC_URL || 'PUBLIC_URL is not set; links in solver.md fall back to the Host header', 'warn'),
      check('Database', onVolume, `${dbPath}${onVolume ? '' : ' (not under /app/data)'} — mount a Railway volume at /app/data or data is lost on redeploy`, 'warn'),
      check('Dispute judge', claudeEnabled(), claudeEnabled() ? `Claude (${MODEL})` : 'no ANTHROPIC_API_KEY: disputes wait for an admin ruling', 'warn'),
      check('House agent', house, house ? `${house.me.name}, last run ${houseState.at ? new Date(houseState.at).toISOString() : 'not yet'}${houseState.last?.error ? `, error: ${houseState.last.error}` : ''}` : 'off: set HOUSE_AGENT=1 (needs ANTHROPIC_API_KEY) so new intents always get a bid', 'warn'),
    ];
    if (payments) {
      const t = await payments.treasury().catch((e) => ({ last_error: e.message }));
      const gas = t.gas_balance_wei ? BigInt(t.gas_balance_wei) : null;
      checks.push(
        check('Chain connection', payments.ready && !payments.lastError, payments.ready ? `${payCfg.chainName} (${payCfg.chainId}), scanned to block ${t.cursor_block ?? '—'}${payments.lastError ? `; last error: ${payments.lastError}` : ''}` : `not connected: ${payments.lastError || 'checking'}`),
        check('Hot wallet key', payments.chain.canSend, payments.chain.canSend ? `treasury ${payments.chain.treasury}` : 'HOT_WALLET_PRIVATE_KEY is not set: deposits work, withdrawals cannot be sent'),
        check('Gas for withdrawals', gas != null && gas >= 10n ** 15n, gas == null ? 'unknown' : `${Number(gas / 10n ** 12n) / 1e6} ETH`, 'warn'),
        check('Solvency', t.solvent, t.solvent == null ? 'unknown' : `${t.onchain_balance} on-chain vs ${t.owed_total} owed`),
        check('RPC endpoint', !payCfg.rpcUrl.includes('rpc.mainnet.chain.robinhood.com'), payCfg.rpcUrl.includes('rpc.mainnet.chain.robinhood.com') ? 'public, rate-limited RPC: use a provider for production' : 'custom provider', 'warn'),
      );
    } else {
      checks.push(check('Payments', true, 'test credits (set PAYMENTS=token to settle in MUSEBOOK)'));
    }
    return { version: VERSION, uptime_s: Math.round((Date.now() - STARTED) / 1000), payments: payments ? 'token' : 'credits', ok: checks.every((c) => c.level !== 'error'), checks };
  }

  const pay = () => {
    if (!payments) throw new HttpError(404, 'on-chain payments are not enabled on this server', 'payments_disabled');
    return payments;
  };
  const admin = (req) => {
    if (!adminToken || !safeEqual(bearer(req), adminToken)) throw new HttpError(401, 'admin token required', 'unauthorized');
  };

  const api = [
    ['POST', /^\/api\/accounts$/, async ({ body, ip }) => {
      if (!signupLimit(ip)) throw new HttpError(429, 'too many signups from this address, try again later', 'rate_limited');
      return [201, market.createAccount(body)];
    }],
    ['GET', /^\/api\/me$/, ({ me }) => market.account(need(me).id, { self: true })],
    ['PATCH', /^\/api\/me$/, ({ me, body }) => {
      const patch = {};
      if ('bio' in body) patch.bio = body.bio ?? '';
      if ('webhook_url' in body) patch.webhook_url = validateWebhookUrl(body.webhook_url, { allowPrivate: allowPrivateWebhooks });
      return market.updateProfile(need(me), patch);
    }],
    ['GET', /^\/api\/me\/ledger$/, ({ me }) => ({ entries: market.ledgerFor(need(me).id) })],
    ['GET', /^\/api\/me\/intents$/, ({ me }) => ({
      posted: market.listIntents({ poster: need(me).id, limit: 100 }),
      solving: market.listIntents({ solver: me.id, limit: 100 }),
    })],
    ['GET', /^\/api\/accounts\/([^/]+)$/, ({ params }) => found(market.accountByName(decodeURIComponent(params[0])), 'account')],
    ['GET', /^\/api\/leaderboard$/, () => ({ agents: market.leaderboard() })],
    ['GET', /^\/api\/stats$/, () => ({ ...market.stats(), judge: judgeEnabled() ? 'claude' : 'admin', house_agent: house ? house.me.name : null, version: VERSION })],
    ['GET', /^\/api\/intents$/, ({ query }) => ({ intents: market.listIntents({ status: query.get('status') || undefined, tag: query.get('tag') || undefined, q: query.get('q') || undefined, limit: query.get('limit') }) })],
    ['POST', /^\/api\/intents$/, ({ me, body }) => [201, market.createIntent(need(me), body)]],
    ['GET', /^\/api\/intents\/([^/]+)$/, ({ me, params }) => market.intent(params[0], me)],
    ['POST', /^\/api\/intents\/([^/]+)\/bids$/, ({ me, params, body }) => [201, market.placeBid(need(me), params[0], body)]],
    ['DELETE', /^\/api\/intents\/([^/]+)\/bids$/, ({ me, params }) => market.withdrawBid(need(me), params[0])],
    ['POST', /^\/api\/intents\/([^/]+)\/award$/, ({ me, params, body }) => market.award(need(me), params[0], body.bid_id)],
    ['POST', /^\/api\/intents\/([^/]+)\/deliver$/, ({ me, params, body }) => market.deliver(need(me), params[0], body)],
    ['POST', /^\/api\/intents\/([^/]+)\/accept$/, ({ me, params, body }) => market.accept(need(me), params[0], body)],
    ['POST', /^\/api\/intents\/([^/]+)\/reject$/, ({ me, params, body }) => {
      const out = market.reject(need(me), params[0], body);
      startJudge(params[0]);
      return out;
    }],
    ['POST', /^\/api\/intents\/([^/]+)\/cancel$/, ({ me, params }) => market.cancel(need(me), params[0])],
    ['GET', /^\/api\/receipts\/([^/]+)$/, ({ params }) => market.receipt(params[0])],
    ['GET', /^\/api\/events$/, ({ query }) => ({ events: market.events({ after: query.get('after'), limit: query.get('limit') }) })],
    ['GET', /^\/api\/payments$/, () => (payments ? payments.publicConfig() : { mode: 'credits', symbol: 'cr' })],
    ['GET', /^\/api\/wallet$/, ({ me }) => {
      const p = pay(); need(me);
      return { wallet: p.wallet(me.id), balance: market.balance(me.id), deposit_address: p.chain.treasury, deposits: p.deposits(me.id), withdrawals: p.withdrawals({ accountId: me.id }) };
    }],
    ['GET', /^\/api\/wallet\/challenge$/, ({ me, query }) => pay().challenge(need(me), query.get('address'))],
    ['POST', /^\/api\/wallet\/link$/, ({ me, body }) => pay().link(need(me), body)],
    ['POST', /^\/api\/wallet\/withdraw$/, ({ me, body }) => [201, pay().requestWithdrawal(need(me), body)]],
    ['POST', /^\/api\/admin\/resolve\/([^/]+)$/, ({ req, params, body }) => {
      admin(req);
      return market.resolve(params[0], { ...body, judge: 'admin' });
    }],
    ['POST', /^\/api\/admin\/sweep$/, ({ req }) => {
      admin(req);
      return { changed: market.sweep() };
    }],
    ['GET', /^\/api\/admin\/disputes$/, ({ req }) => {
      admin(req);
      return { disputes: market.listIntents({ status: 'disputed', limit: 200 }).map((i) => ({ ...i, case: market.disputeCase(i.id) })) };
    }],
    ['GET', /^\/api\/admin\/treasury$/, ({ req }) => { admin(req); return pay().treasury(); }],
    ['GET', /^\/api\/admin\/withdrawals$/, ({ req, query }) => {
      admin(req);
      const p = pay();
      return { withdrawals: p.withdrawals({ status: query.get('status') || undefined }).map((w) => ({ ...w, wallet_linked_at: p.wallet(w.account_id)?.linked_at ?? null, account_balance: market.balance(w.account_id) })) };
    }],
    ['POST', /^\/api\/admin\/withdrawals\/([^/]+)\/approve$/, ({ req, params }) => { admin(req); return pay().approve(params[0]); }],
    ['POST', /^\/api\/admin\/withdrawals\/([^/]+)\/reject$/, ({ req, params, body }) => { admin(req); return pay().reject(params[0], body.reason); }],
    ['POST', /^\/api\/admin\/withdrawals\/([^/]+)\/rebroadcast$/, ({ req, params }) => { admin(req); return pay().rebroadcast(params[0]); }],
    ['POST', /^\/api\/admin\/withdrawals\/([^/]+)\/refund$/, ({ req, params }) => { admin(req); return pay().refundDropped(params[0]); }],
    ['POST', /^\/api\/admin\/chain\/poll$/, ({ req }) => { admin(req); return pay().poll(); }],
    ['POST', /^\/api\/admin\/payout$/, ({ req, body }) => {
      admin(req);
      const source = body.source === 'house-agent' ? house?.me.id : body.source === 'fees' ? SYS.fees : null;
      if (!source) throw new HttpError(400, "source must be 'fees' or 'house-agent'", 'invalid_input');
      return [201, pay().requestOperatorWithdrawal(source, body)];
    }],
    ['POST', /^\/api\/admin\/house\/tick$/, async ({ req }) => {
      admin(req);
      if (!house) throw new HttpError(404, 'the house agent is off (set HOUSE_AGENT=1 and ANTHROPIC_API_KEY)', 'house_off');
      return houseTick();
    }],
    ['GET', /^\/api\/admin\/health$/, async ({ req }) => { admin(req); return health(); }],
  ];

  const pages = [
    [/^\/$/, () => views.home(market)],
    [/^\/intents$/, ({ query }) => views.intents(market, query.get('status') ?? 'open', query.get('tag') || '', query.get('q') || '')],
    [/^\/i\/([^/]+)$/, ({ params }) => views.intentPage(market, params[0])],
    [/^\/post$/, () => views.postPage()],
    [/^\/join$/, () => views.joinPage()],
    [/^\/me$/, () => views.mePage()],
    [/^\/agents$/, () => views.agentsPage(market)],
    [/^\/u\/([^/]+)$/, ({ params }) => views.profilePage(market, decodeURIComponent(params[0]))],
    [/^\/docs$/, ({ origin }) => views.docsPage(origin, payments?.publicConfig())],
    [/^\/wallet$/, () => views.walletPage(payments?.publicConfig())],
    [/^\/admin$/, () => views.adminPage(Boolean(payments))],
  ];

  async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;
    const origin = process.env.PUBLIC_URL || `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}`;
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    res.setHeader('X-Content-Type-Options', 'nosniff');

    if (path === '/healthz') return send(res, 200, 'ok', 'text/plain');
    if (STATIC[path]) {
      const [file, type] = STATIC[path];
      res.setHeader('Cache-Control', 'public, max-age=300');
      return send(res, 200, readFileSync(join(ROOT, file)), type);
    }
    if (path === '/solver.md' || path === '/skill.md') return send(res, 200, solverDoc(origin, payments?.publicConfig()), 'text/markdown; charset=utf-8');
    if (path === '/.well-known/bountyhall.json') {
      return json(res, 200, { name: 'Bountyhall', api: `${origin}/api`, mcp: `${origin}/mcp`, docs: `${origin}/solver.md`, payments: payments ? payments.publicConfig() : { mode: 'credits' }, receipt_signing: { algorithm: 'ed25519', public_key_spki_base64: market.publicKeyDer } });
    }
    if (path === '/api/stream') return openStream(req, res);
    if (path === '/mcp') return handleMcp(req, res);

    if (path.startsWith('/api/')) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
      if (req.method === 'OPTIONS') return send(res, 204, '');
      try {
        const route = api.find(([m, re]) => m === req.method && re.test(path));
        if (!route) {
          const other = api.some(([, re]) => re.test(path));
          throw new HttpError(other ? 405 : 404, other ? 'method not allowed' : 'no such endpoint', other ? 'method_not_allowed' : 'not_found');
        }
        const me = market.authenticate(bearer(req));
        if (req.method !== 'GET' && me && !writeLimit(me.id)) throw new HttpError(429, 'slow down: too many writes this minute', 'rate_limited');
        const body = req.method === 'POST' || req.method === 'PATCH' ? await readJson(req) : {};
        const out = await route[2]({ req, me, body, ip, query: url.searchParams, params: path.match(route[1]).slice(1) });
        const [status, payload] = Array.isArray(out) ? out : [200, out];
        return json(res, status, payload);
      } catch (err) {
        if (err instanceof HttpError) return json(res, err.status, { error: err.message, code: err.code });
        console.error(err);
        return json(res, 500, { error: 'internal error', code: 'internal' });
      }
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed', 'text/plain');
    try {
      const page = pages.find(([re]) => re.test(path));
      if (!page) return send(res, 404, views.notFound(), 'text/html; charset=utf-8');
      return send(res, 200, page[1]({ query: url.searchParams, params: path.match(page[0]).slice(1), origin }), 'text/html; charset=utf-8');
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) return send(res, 404, views.notFound(), 'text/html; charset=utf-8');
      console.error(err);
      return send(res, 500, 'internal error', 'text/plain');
    }
  }

  // MCP over Streamable HTTP, stateless: each POST carries one JSON-RPC message
  // (or a batch) and gets a JSON reply. There is no server-initiated stream.
  async function handleMcp(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Mcp-Protocol-Version, Mcp-Session-Id');
    if (req.method === 'OPTIONS') return send(res, 204, '');
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return send(res, 405, 'method not allowed', 'text/plain'); }
    const key = bearer(req);
    const me = market.authenticate(key);
    if (key && !me) return json(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'invalid API key' } });
    if (me && !writeLimit(me.id)) return json(res, 429, { jsonrpc: '2.0', id: null, error: { code: -32002, message: 'rate limited' } });
    let body;
    try { body = await readJson(req, { allowArray: true }); } catch { return json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); }
    const hooks = { onReject: startJudge, payments };
    try {
      if (Array.isArray(body)) {
        const out = body.map((m) => handleRpc(market, me, m, hooks)).filter(Boolean);
        return out.length ? json(res, 200, out) : send(res, 202, '');
      }
      const out = handleRpc(market, me, body, hooks);
      return out ? json(res, 200, out) : send(res, 202, '');
    } catch (err) {
      console.error(err);
      return json(res, 500, { jsonrpc: '2.0', id: body?.id ?? null, error: { code: -32603, message: 'internal error' } });
    }
  }

  function openStream(req, res) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write(': hello\n\n');
    streams.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => { clearInterval(ping); streams.delete(res); });
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => { console.error(err); if (!res.headersSent) send(res, 500, 'internal error', 'text/plain'); });
  });
  server.on('close', () => { if (sweeper) clearInterval(sweeper); if (poller) clearInterval(poller); if (houseTimer) clearInterval(houseTimer); for (const s of streams) s.end(); db.close(); });
  const settleWebhooks = () => Promise.all([...webhookJobs]);
  return { server, market, db, payments, house, houseTick, settleWebhooks };
}

function need(me) {
  if (!me) throw new HttpError(401, 'missing or invalid API key (send Authorization: Bearer bh_...)', 'unauthorized');
  return me;
}
function found(v, what) {
  if (!v) throw new HttpError(404, `${what} not found`, 'not_found');
  return v;
}
function bearer(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
}
function safeEqual(a, b) {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}
function send(res, status, body, type) {
  if (type) res.setHeader('Content-Type', type);
  res.writeHead(status);
  res.end(body);
}
function json(res, status, payload) {
  send(res, status, JSON.stringify(payload), 'application/json; charset=utf-8');
}
function readJson(req, { allowArray = false } = {}) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new HttpError(413, 'request body too large', 'too_large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (allowArray && Array.isArray(v)) return resolve(v);
        resolve(v && typeof v === 'object' && !Array.isArray(v) ? v : {});
      } catch { reject(new HttpError(400, 'body must be valid JSON', 'invalid_json')); }
    });
    req.on('error', reject);
  });
}
