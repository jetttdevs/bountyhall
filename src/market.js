// The marketplace: accounts, the escrow ledger, and the intent state machine.
//
//   open ──award──▶ awarded ──deliver──▶ delivered ──accept / review timeout──▶ completed
//    │                 │                     └──reject──▶ disputed ──verdict──▶ resolved
//    ├─cancel─▶ cancelled
//    └─no bids─▶ expired     └─missed deadline─▶ failed
//
// Money: posting an intent moves the full budget into escrow. Awarding refunds
// (budget - price). Settlement pays the solver (minus the house fee) and refunds
// whatever the verdict does not award. Every ledger transaction sums to zero.
import { generateKeyPairSync, createPrivateKey, createPublicKey, sign as edSign, randomBytes } from 'node:crypto';
import { tx } from './db.js';
import { HttpError, newId, now, sha256, str, int, HOUR, MINUTE } from './util.js';

export const SYS = { faucet: 'sys_faucet', escrow: 'sys_escrow', fees: 'sys_fees', chain: 'sys_chain', withdrawals: 'sys_withdrawals' };
export const FINAL = ['completed', 'resolved', 'failed', 'cancelled', 'expired'];
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{1,31}$/;

export class Market {
  constructor(db, opts = {}) {
    this.db = db;
    this.feeBps = opts.feeBps ?? Number(process.env.FEE_BPS ?? 250);
    this.signupCredits = opts.signupCredits ?? Number(process.env.SIGNUP_CREDITS ?? 1000);
    this.reviewHours = opts.reviewHours ?? Number(process.env.REVIEW_HOURS ?? 24);
    this.staleOpenHours = opts.staleOpenHours ?? 24 * 7;
    this.listeners = new Set();
    this.#bootstrap();
  }

  // ---------- setup ----------
  #bootstrap() {
    const t = now();
    const ins = this.db.prepare('INSERT OR IGNORE INTO accounts (id, name, kind, bio, created_at) VALUES (?, ?, ?, ?, ?)');
    ins.run(SYS.faucet, 'faucet', 'system', 'mints starter credits', t);
    ins.run(SYS.escrow, 'escrow', 'system', 'holds budgets until work is settled', t);
    ins.run(SYS.fees, 'house', 'system', 'collects the house fee', t);
    ins.run(SYS.chain, 'treasury', 'system', 'tokens held on-chain; its negative balance is what the treasury owes', t);
    ins.run(SYS.withdrawals, 'outbox', 'system', 'withdrawals waiting for approval or confirmation', t);
    let pem = this.db.prepare("SELECT v FROM meta WHERE k = 'signing_key'").get()?.v;
    if (!pem) {
      const { privateKey } = generateKeyPairSync('ed25519');
      pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
      this.db.prepare("INSERT INTO meta (k, v) VALUES ('signing_key', ?)").run(pem);
    }
    this.signingKey = createPrivateKey(pem);
    this.publicKeyDer = createPublicKey(this.signingKey).export({ type: 'spki', format: 'der' }).toString('base64');
  }

  onEvent(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  #event(type, intentId, actorId, data = {}) {
    const t = now();
    const r = this.db.prepare('INSERT INTO events (type, intent_id, actor_id, data, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(type, intentId, actorId, JSON.stringify(data), t);
    const ev = { seq: Number(r.lastInsertRowid), type, intent_id: intentId, actor_id: actorId, data, created_at: t };
    queueMicrotask(() => { for (const fn of this.listeners) { try { fn(ev); } catch {} } });
    return ev;
  }

  // ---------- ledger ----------
  #transfer(legs, memo, intentId = null) {
    const sum = legs.reduce((a, [, amt]) => a + amt, 0);
    if (sum !== 0) throw new Error(`unbalanced ledger transaction (${sum})`);
    const txId = newId('tx');
    const t = now();
    const ins = this.db.prepare('INSERT INTO ledger (tx_id, account_id, amount, memo, intent_id, created_at) VALUES (?, ?, ?, ?, ?, ?)');
    for (const [acct, amt] of legs) if (amt !== 0) ins.run(txId, acct, amt, memo, intentId, t);
    return txId;
  }

  balance(accountId) {
    return Number(this.db.prepare('SELECT COALESCE(SUM(amount), 0) AS b FROM ledger WHERE account_id = ?').get(accountId).b);
  }

  ledgerFor(accountId, limit = 100) {
    return this.db.prepare('SELECT seq, tx_id, amount, memo, intent_id, created_at FROM ledger WHERE account_id = ? ORDER BY seq DESC LIMIT ?').all(accountId, limit);
  }

  // Ledger access for the payments module. Call inside tx(); legs must sum to zero.
  transfer(legs, memo, intentId = null) {
    return this.#transfer(legs, memo, intentId);
  }

  ledgerTotal() {
    return Number(this.db.prepare('SELECT COALESCE(SUM(amount), 0) AS s FROM ledger').get().s);
  }

  // ---------- accounts ----------
  createAccount({ name, kind = 'agent', bio = '' }) {
    name = str(name, 'name', { min: 2, max: 32 });
    if (!NAME_RE.test(name)) throw new HttpError(400, 'name may use letters, digits, _ . - and must start with a letter or digit', 'invalid_input');
    if (!['human', 'agent'].includes(kind)) throw new HttpError(400, "kind must be 'human' or 'agent'", 'invalid_input');
    bio = str(bio, 'bio', { min: 0, max: 280, required: false });
    const apiKey = `bh_${randomBytes(24).toString('base64url')}`;
    const id = newId('acct');
    return tx(this.db, () => {
      if (this.db.prepare('SELECT 1 FROM accounts WHERE name = ?').get(name)) throw new HttpError(409, 'that name is taken', 'name_taken');
      this.db.prepare('INSERT INTO accounts (id, name, kind, bio, key_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, name, kind, bio, sha256(apiKey), now());
      if (this.signupCredits > 0) this.#transfer([[SYS.faucet, -this.signupCredits], [id, this.signupCredits]], 'signup credits');
      this.#event('account.joined', null, id, { name, kind });
      return { account: this.account(id), api_key: apiKey };
    });
  }

  authenticate(apiKey) {
    if (!apiKey) return null;
    return this.db.prepare('SELECT id, name, kind, bio, created_at FROM accounts WHERE key_hash = ?').get(sha256(apiKey)) || null;
  }

  account(id, { self = false } = {}) {
    const a = this.db.prepare("SELECT id, name, kind, bio, webhook_url, created_at FROM accounts WHERE id = ? AND kind != 'system'").get(id);
    if (!a) return null;
    const { webhook_url, ...pub } = a;
    return { ...pub, ...(self ? { webhook_url } : {}), balance: this.balance(a.id), reputation: this.reputation(a.id) };
  }

  accountByName(name) {
    const a = this.db.prepare("SELECT id FROM accounts WHERE name = ? AND kind != 'system'").get(name);
    return a ? this.account(a.id) : null;
  }

  // Update your own profile. webhook_url is validated by the caller (server).
  updateProfile(me, { bio, webhook_url }) {
    if (bio !== undefined) this.db.prepare('UPDATE accounts SET bio = ? WHERE id = ?').run(str(bio, 'bio', { min: 0, max: 280, required: false }), me.id);
    if (webhook_url !== undefined) this.db.prepare('UPDATE accounts SET webhook_url = ? WHERE id = ?').run(webhook_url || null, me.id);
    return this.account(me.id, { self: true });
  }

  webhookUrl(accountId) {
    return this.db.prepare('SELECT webhook_url FROM accounts WHERE id = ?').get(accountId)?.webhook_url || null;
  }

  // Who is involved in an intent: the poster and, once awarded, the winner.
  participants(intentId) {
    const i = this.db.prepare('SELECT poster_id, awarded_bid_id FROM intents WHERE id = ?').get(intentId);
    if (!i) return null;
    const solver = i.awarded_bid_id ? this.db.prepare('SELECT solver_id FROM bids WHERE id = ?').get(i.awarded_bid_id)?.solver_id : null;
    return { poster_id: i.poster_id, solver_id: solver || null };
  }

  sign(bytes) {
    return edSign(null, Buffer.from(bytes), this.signingKey).toString('base64');
  }

  // Solver reputation: Laplace-smoothed share of value delivered, plus ratings.
  reputation(accountId) {
    const r = this.db.prepare(`
      SELECT COUNT(*) AS jobs,
             COALESCE(SUM(i.solver_share), 0) AS share_sum,
             SUM(CASE WHEN i.status = 'failed' THEN 1 ELSE 0 END) AS failed,
             AVG(i.rating) AS avg_rating,
             COUNT(i.rating) AS ratings
      FROM intents i JOIN bids b ON b.id = i.awarded_bid_id
      WHERE b.solver_id = ? AND i.status IN ('completed', 'resolved', 'failed')`).get(accountId);
    const earned = Number(this.db.prepare("SELECT COALESCE(SUM(amount), 0) AS e FROM ledger WHERE account_id = ? AND memo = 'payout'").get(accountId).e);
    const jobs = Number(r.jobs);
    const delivered = (Number(r.share_sum) / 100 + 1) / (jobs + 2);
    const rating = r.avg_rating == null ? 0.8 : Number(r.avg_rating) / 5;
    const score = Math.round((0.7 * delivered + 0.3 * rating) * 1000) / 1000;
    return { score, jobs, failed: Number(r.failed), avg_rating: r.avg_rating == null ? null : Math.round(r.avg_rating * 10) / 10, ratings: Number(r.ratings), earned };
  }

  leaderboard(limit = 50) {
    const ids = this.db.prepare("SELECT id FROM accounts WHERE kind = 'agent'").all().map((r) => r.id);
    return ids.map((id) => this.account(id))
      .sort((a, b) => b.reputation.earned - a.reputation.earned || b.reputation.score - a.reputation.score)
      .slice(0, limit);
  }

  // ---------- intents ----------
  #intentRow(id) {
    const i = this.db.prepare('SELECT * FROM intents WHERE id = ?').get(id);
    if (!i) throw new HttpError(404, 'intent not found', 'not_found');
    return i;
  }

  #setStatus(id, status, extra = {}) {
    const cols = Object.keys(extra);
    const sets = ['status = ?', 'updated_at = ?', ...cols.map((c) => `${c} = ?`)].join(', ');
    this.db.prepare(`UPDATE intents SET ${sets} WHERE id = ?`).run(status, now(), ...cols.map((c) => extra[c]), id);
  }

  createIntent(poster, input) {
    const title = str(input.title, 'title', { min: 4, max: 140 });
    const body = str(input.body, 'body', { min: 10, max: 8000 });
    const budget = int(input.budget, 'budget', { min: 1, max: 1_000_000_000_000 });
    const windowMin = int(input.bid_window_minutes, 'bid_window_minutes', { min: 1, max: 10080, fallback: 60 });
    const tags = normalizeTags(input.tags);
    const autoAward = input.auto_award ? 1 : 0;
    const parentId = input.parent_id ? String(input.parent_id) : null;
    const id = newId('int');
    return tx(this.db, () => {
      if (parentId) {
        const parent = this.#intentRow(parentId);
        const win = parent.awarded_bid_id && this.db.prepare('SELECT solver_id FROM bids WHERE id = ?').get(parent.awarded_bid_id);
        if (parent.status !== 'awarded' || !win || win.solver_id !== poster.id) {
          throw new HttpError(403, 'you can only subcontract an intent you won and have not delivered yet', 'forbidden');
        }
      }
      if (this.balance(poster.id) < budget) throw new HttpError(402, 'insufficient balance for this budget', 'insufficient_funds');
      const t = now();
      this.db.prepare(`INSERT INTO intents (id, poster_id, parent_id, title, body, tags, budget, status, auto_award, bid_deadline, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`).run(id, poster.id, parentId, title, body, tags, budget, autoAward, t + windowMin * MINUTE, t, t);
      this.#transfer([[poster.id, -budget], [SYS.escrow, budget]], 'escrow budget', id);
      this.#event('intent.created', id, poster.id, { title, budget });
      return this.intent(id, poster);
    });
  }

  listIntents({ status, limit = 50, poster, solver, tag, q } = {}) {
    const where = [];
    const args = [];
    if (status === 'active') where.push("i.status IN ('open', 'awarded', 'delivered', 'disputed')");
    else if (status === 'done') where.push(`i.status IN (${FINAL.map(() => '?').join(',')})`), args.push(...FINAL);
    else if (status) where.push('i.status = ?'), args.push(status);
    if (poster) where.push('i.poster_id = ?'), args.push(poster);
    if (solver) where.push('i.awarded_bid_id IN (SELECT id FROM bids WHERE solver_id = ?)'), args.push(solver);
    if (tag) where.push("(',' || i.tags || ',') LIKE ? ESCAPE '\\'"), args.push(`%,${escapeLike(String(tag).toLowerCase())},%`);
    if (q && String(q).trim()) {
      const like = `%${escapeLike(String(q).trim().slice(0, 100))}%`;
      where.push("(i.title LIKE ? ESCAPE '\\' OR i.body LIKE ? ESCAPE '\\')"), args.push(like, like);
    }
    const sql = `SELECT i.*, a.name AS poster_name,
        (SELECT COUNT(*) FROM bids b WHERE b.intent_id = i.id AND b.status != 'withdrawn') AS bid_count
      FROM intents i JOIN accounts a ON a.id = i.poster_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY i.created_at DESC LIMIT ?`;
    return this.db.prepare(sql).all(...args, Math.min(Number(limit) || 50, 200)).map((i) => this.#publicIntent(i));
  }

  #publicIntent(i) {
    const won = i.awarded_bid_id ? this.db.prepare('SELECT b.id, b.price, b.eta_hours, b.solver_id, a.name AS solver_name FROM bids b JOIN accounts a ON a.id = b.solver_id WHERE b.id = ?').get(i.awarded_bid_id) : null;
    return {
      id: i.id, title: i.title, body: i.body, tags: i.tags ? i.tags.split(',') : [], budget: i.budget, status: i.status,
      poster: { id: i.poster_id, name: i.poster_name ?? this.db.prepare('SELECT name FROM accounts WHERE id = ?').get(i.poster_id)?.name },
      parent_id: i.parent_id, auto_award: !!i.auto_award,
      bid_count: i.bid_count ?? Number(this.db.prepare("SELECT COUNT(*) AS c FROM bids WHERE intent_id = ? AND status != 'withdrawn'").get(i.id).c),
      bidding_open: i.status === 'open' && now() < i.bid_deadline,
      bid_deadline: i.bid_deadline, deliver_deadline: i.deliver_deadline, review_deadline: i.review_deadline,
      winner: won ? { bid_id: won.id, solver_id: won.solver_id, solver_name: won.solver_name, price: won.price, eta_hours: won.eta_hours } : null,
      solver_share: i.solver_share, rating: i.rating, dispute_reason: i.dispute_reason,
      created_at: i.created_at, updated_at: i.updated_at,
    };
  }

  // Bids are sealed: the poster sees all of them, a solver sees only their own.
  // Deliveries are private to poster and winner until the intent is final.
  intent(id, viewer = null) {
    const i = this.#intentRow(id);
    const out = this.#publicIntent(i);
    const isPoster = viewer && viewer.id === i.poster_id;
    const isWinner = viewer && out.winner && viewer.id === out.winner.solver_id;
    const bidSql = "SELECT b.id, b.solver_id, a.name AS solver_name, b.price, b.eta_hours, b.pitch, b.status, b.created_at FROM bids b JOIN accounts a ON a.id = b.solver_id WHERE b.intent_id = ? AND b.status != 'withdrawn'";
    if (isPoster) {
      out.bids = this.db.prepare(bidSql + ' ORDER BY b.price ASC').all(id).map((b) => ({ ...b, solver_reputation: this.reputation(b.solver_id).score }));
    } else if (viewer) {
      out.my_bid = this.db.prepare(bidSql + ' AND b.solver_id = ?').get(id, viewer.id) || null;
    }
    const delivery = this.db.prepare('SELECT id, solver_id, content, created_at FROM deliveries WHERE intent_id = ? ORDER BY created_at DESC LIMIT 1').get(id);
    if (delivery && (isPoster || isWinner || ['completed', 'resolved'].includes(i.status))) out.delivery = delivery;
    else out.delivery = delivery ? { id: delivery.id, created_at: delivery.created_at, hidden: true } : null;
    out.verdict = this.db.prepare('SELECT judge, solver_share, rationale, created_at FROM verdicts WHERE intent_id = ? ORDER BY created_at DESC LIMIT 1').get(id) || null;
    out.receipt = this.db.prepare('SELECT id FROM receipts WHERE intent_id = ?').get(id)?.id || null;
    out.children = this.db.prepare('SELECT id, title, status, budget FROM intents WHERE parent_id = ?').all(id);
    out.viewer_role = isPoster ? 'poster' : isWinner ? 'solver' : viewer ? 'visitor' : 'anonymous';
    return out;
  }

  placeBid(solver, intentId, input) {
    const price = int(input.price, 'price', { min: 1 });
    const eta = int(input.eta_hours, 'eta_hours', { min: 1, max: 720 });
    const pitch = str(input.pitch, 'pitch', { min: 10, max: 2000 });
    return tx(this.db, () => {
      const i = this.#intentRow(intentId);
      if (i.status !== 'open' || now() >= i.bid_deadline) throw new HttpError(409, 'bidding is closed on this intent', 'bidding_closed');
      if (i.poster_id === solver.id) throw new HttpError(403, 'you cannot bid on your own intent', 'forbidden');
      if (price > i.budget) throw new HttpError(400, `price must be <= budget (${i.budget})`, 'invalid_input');
      const t = now();
      const existing = this.db.prepare('SELECT id FROM bids WHERE intent_id = ? AND solver_id = ?').get(intentId, solver.id);
      let bidId;
      if (existing) {
        bidId = existing.id;
        this.db.prepare("UPDATE bids SET price = ?, eta_hours = ?, pitch = ?, status = 'pending', updated_at = ? WHERE id = ?").run(price, eta, pitch, t, bidId);
      } else {
        bidId = newId('bid');
        this.db.prepare('INSERT INTO bids (id, intent_id, solver_id, price, eta_hours, pitch, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(bidId, intentId, solver.id, price, eta, pitch, t, t);
      }
      // sealed: the public event carries no price
      this.#event('bid.placed', intentId, solver.id, { updated: !!existing });
      return this.db.prepare('SELECT id, intent_id, price, eta_hours, pitch, status, created_at, updated_at FROM bids WHERE id = ?').get(bidId);
    });
  }

  withdrawBid(solver, intentId) {
    return tx(this.db, () => {
      const i = this.#intentRow(intentId);
      if (i.status !== 'open') throw new HttpError(409, 'bids can only be withdrawn while the intent is open', 'invalid_state');
      const r = this.db.prepare("UPDATE bids SET status = 'withdrawn', updated_at = ? WHERE intent_id = ? AND solver_id = ? AND status = 'pending'").run(now(), intentId, solver.id);
      if (!r.changes) throw new HttpError(404, 'you have no pending bid here', 'not_found');
      return { ok: true };
    });
  }

  // Score = cheaper is better (60%) + solver reputation (40%).
  #bestBid(i) {
    const bids = this.db.prepare("SELECT * FROM bids WHERE intent_id = ? AND status = 'pending' ORDER BY created_at ASC").all(i.id);
    let best = null;
    for (const b of bids) {
      const score = 0.6 * (1 - b.price / i.budget) + 0.4 * this.reputation(b.solver_id).score;
      if (!best || score > best.score) best = { bid: b, score };
    }
    return best?.bid || null;
  }

  award(poster, intentId, bidId) {
    return tx(this.db, () => {
      const i = this.#intentRow(intentId);
      if (poster && i.poster_id !== poster.id) throw new HttpError(403, 'only the poster can award this intent', 'forbidden');
      if (i.status !== 'open') throw new HttpError(409, `cannot award an intent that is ${i.status}`, 'invalid_state');
      const bid = bidId
        ? this.db.prepare("SELECT * FROM bids WHERE id = ? AND intent_id = ? AND status = 'pending'").get(String(bidId), intentId)
        : this.#bestBid(i);
      if (!bid) throw new HttpError(404, bidId ? 'bid not found or not pending' : 'there are no bids to award', 'not_found');
      this.#awardBid(i, bid, poster?.id ?? null, !bidId);
      return this.intent(intentId, poster);
    });
  }

  deliver(solver, intentId, input) {
    const content = str(input.content, 'content', { min: 1, max: 20000 });
    return tx(this.db, () => {
      const i = this.#intentRow(intentId);
      const win = i.awarded_bid_id && this.db.prepare('SELECT solver_id FROM bids WHERE id = ?').get(i.awarded_bid_id);
      if (!win || win.solver_id !== solver.id) throw new HttpError(403, 'only the awarded solver can deliver', 'forbidden');
      if (i.status !== 'awarded') throw new HttpError(409, `cannot deliver on an intent that is ${i.status}`, 'invalid_state');
      const open = this.db.prepare("SELECT COUNT(*) AS c FROM intents WHERE parent_id = ? AND status IN ('open', 'awarded', 'delivered', 'disputed')").get(intentId).c;
      if (open) throw new HttpError(409, 'settle your open subcontracts before delivering', 'invalid_state');
      this.db.prepare('INSERT INTO deliveries (id, intent_id, solver_id, content, created_at) VALUES (?, ?, ?, ?, ?)').run(newId('dlv'), intentId, solver.id, content, now());
      this.#setStatus(intentId, 'delivered', { review_deadline: now() + this.reviewHours * HOUR });
      this.#event('intent.delivered', intentId, solver.id, {});
      return this.intent(intentId, solver);
    });
  }

  accept(poster, intentId, input = {}) {
    const rating = input.rating == null || input.rating === '' ? null : int(input.rating, 'rating', { min: 1, max: 5 });
    return tx(this.db, () => {
      const i = this.#intentRow(intentId);
      if (i.poster_id !== poster.id) throw new HttpError(403, 'only the poster can accept', 'forbidden');
      if (i.status !== 'delivered') throw new HttpError(409, `cannot accept an intent that is ${i.status}`, 'invalid_state');
      this.#settle(i, 100, 'poster', rating == null ? 'accepted by the poster' : `accepted by the poster, rated ${rating}/5`, 'completed', rating);
      return this.intent(intentId, poster);
    });
  }

  reject(poster, intentId, input) {
    const reason = str(input.reason, 'reason', { min: 10, max: 2000 });
    return tx(this.db, () => {
      const i = this.#intentRow(intentId);
      if (i.poster_id !== poster.id) throw new HttpError(403, 'only the poster can reject', 'forbidden');
      if (i.status !== 'delivered') throw new HttpError(409, `cannot reject an intent that is ${i.status}`, 'invalid_state');
      this.#setStatus(intentId, 'disputed', { dispute_reason: reason });
      this.#event('intent.disputed', intentId, poster.id, {});
      return this.intent(intentId, poster);
    });
  }

  // Everything a judge needs to rule on a dispute.
  disputeCase(intentId) {
    const i = this.#intentRow(intentId);
    if (i.status !== 'disputed') return null;
    const bid = this.db.prepare('SELECT price, eta_hours, pitch FROM bids WHERE id = ?').get(i.awarded_bid_id);
    const delivery = this.db.prepare('SELECT content FROM deliveries WHERE intent_id = ? ORDER BY created_at DESC LIMIT 1').get(intentId);
    return { id: i.id, title: i.title, body: i.body, price: bid.price, pitch: bid.pitch, delivery: delivery?.content ?? '', reason: i.dispute_reason };
  }

  resolve(intentId, { solver_share, rationale, judge = 'admin' }) {
    const share = int(solver_share, 'solver_share', { min: 0, max: 100 });
    const why = str(rationale, 'rationale', { min: 1, max: 4000 });
    return tx(this.db, () => {
      const i = this.#intentRow(intentId);
      if (i.status !== 'disputed') throw new HttpError(409, `cannot resolve an intent that is ${i.status}`, 'invalid_state');
      this.#settle(i, share, judge, why, 'resolved', null);
      return this.intent(intentId);
    });
  }

  cancel(poster, intentId) {
    return tx(this.db, () => {
      const i = this.#intentRow(intentId);
      if (i.poster_id !== poster.id) throw new HttpError(403, 'only the poster can cancel', 'forbidden');
      if (i.status !== 'open') throw new HttpError(409, 'only open intents can be cancelled', 'invalid_state');
      this.#closeUnawarded(i, 'cancelled');
      return this.intent(intentId, poster);
    });
  }

  #closeUnawarded(i, status) {
    this.db.prepare("UPDATE bids SET status = 'lost', updated_at = ? WHERE intent_id = ? AND status = 'pending'").run(now(), i.id);
    this.#setStatus(i.id, status);
    this.#transfer([[SYS.escrow, -i.budget], [i.poster_id, i.budget]], `budget refund (${status})`, i.id);
    this.#event(`intent.${status}`, i.id, null, {});
  }

  // Pay out escrow for an awarded intent: share% of the price to the solver
  // (minus the house fee), the rest back to the poster. Signs a receipt.
  #settle(i, share, judge, rationale, status, rating) {
    const bid = this.db.prepare('SELECT * FROM bids WHERE id = ?').get(i.awarded_bid_id);
    const gross = Math.floor((bid.price * share) / 100);
    const fee = Math.floor((gross * this.feeBps) / 10000);
    const toSolver = gross - fee;
    const refund = bid.price - gross;
    // one transaction per memo keeps the ledger readable
    if (toSolver) this.#transfer([[SYS.escrow, -toSolver], [bid.solver_id, toSolver]], 'payout', i.id);
    if (fee) this.#transfer([[SYS.escrow, -fee], [SYS.fees, fee]], 'house fee', i.id);
    if (refund) this.#transfer([[SYS.escrow, -refund], [i.poster_id, refund]], 'refund (verdict)', i.id);
    const t = now();
    this.db.prepare('INSERT INTO verdicts (id, intent_id, judge, solver_share, rationale, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(newId('vrd'), i.id, judge, share, rationale, t);
    this.#setStatus(i.id, status, { solver_share: share, rating });
    const payload = JSON.stringify({ v: 1, intent_id: i.id, poster_id: i.poster_id, solver_id: bid.solver_id, price: bid.price, solver_share: share, to_solver: toSolver, fee, refund, judge, status, settled_at: t });
    const signature = this.sign(payload);
    const receiptId = newId('rcpt');
    this.db.prepare('INSERT INTO receipts (id, intent_id, payload, signature, created_at) VALUES (?, ?, ?, ?, ?)').run(receiptId, i.id, payload, signature, t);
    this.#event(`intent.${status}`, i.id, null, { solver_share: share, to_solver: toSolver });
    return receiptId;
  }

  #fail(i) {
    const bid = this.db.prepare('SELECT * FROM bids WHERE id = ?').get(i.awarded_bid_id);
    this.#transfer([[SYS.escrow, -bid.price], [i.poster_id, bid.price]], 'refund (solver missed deadline)', i.id);
    this.#setStatus(i.id, 'failed', { solver_share: 0 });
    this.#event('intent.failed', i.id, null, { solver_id: bid.solver_id });
  }

  receipt(id) {
    const r = this.db.prepare('SELECT * FROM receipts WHERE id = ?').get(id);
    if (!r) throw new HttpError(404, 'receipt not found', 'not_found');
    return { id: r.id, intent_id: r.intent_id, payload: r.payload, signature: r.signature, algorithm: 'ed25519', public_key_spki_base64: this.publicKeyDer, created_at: r.created_at };
  }

  // Time-driven transitions. Safe to call as often as you like.
  sweep() {
    const t = now();
    let changed = 0;
    const each = (sql, fn) => {
      for (const i of this.db.prepare(sql).all(t)) {
        try { tx(this.db, () => fn(this.#intentRow(i.id))); changed++; } catch (err) { if (!(err instanceof HttpError)) throw err; }
      }
    };
    // bidding closed: auto-award, or expire when nobody bid
    each("SELECT id FROM intents WHERE status = 'open' AND bid_deadline <= ?", (i) => {
      if (i.status !== 'open') return;
      const hasBids = this.db.prepare("SELECT COUNT(*) AS c FROM bids WHERE intent_id = ? AND status = 'pending'").get(i.id).c > 0;
      if (!hasBids) return this.#closeUnawarded(i, 'expired');
      if (i.auto_award) return this.#awardBid(i, this.#bestBid(i), null, true);
      if (t >= i.bid_deadline + this.staleOpenHours * HOUR) return this.#closeUnawarded(i, 'expired');
      throw new HttpError(409, 'waiting on the poster');
    });
    each("SELECT id FROM intents WHERE status = 'awarded' AND deliver_deadline <= ?", (i) => this.#fail(i));
    each("SELECT id FROM intents WHERE status = 'delivered' AND review_deadline <= ?", (i) =>
      this.#settle(i, 100, 'timeout', 'the poster did not review in time; auto-accepted', 'completed', null));
    return changed;
  }

  // Mark the winner, close the other bids, start the delivery clock and refund
  // the part of the budget the winning price does not use.
  #awardBid(i, bid, actorId, auto) {
    const t = now();
    this.db.prepare("UPDATE bids SET status = 'won', updated_at = ? WHERE id = ?").run(t, bid.id);
    this.db.prepare("UPDATE bids SET status = 'lost', updated_at = ? WHERE intent_id = ? AND id != ? AND status = 'pending'").run(t, i.id, bid.id);
    this.#setStatus(i.id, 'awarded', { awarded_bid_id: bid.id, deliver_deadline: t + bid.eta_hours * HOUR });
    const refund = i.budget - bid.price;
    if (refund > 0) this.#transfer([[SYS.escrow, -refund], [i.poster_id, refund]], 'budget refund (award below budget)', i.id);
    this.#event('intent.awarded', i.id, actorId, { solver_id: bid.solver_id, price: bid.price, auto });
  }

  events({ after = 0, limit = 50 } = {}) {
    return this.db.prepare(`SELECT e.seq, e.type, e.intent_id, e.actor_id, a.name AS actor_name, i.title AS intent_title, e.data, e.created_at
      FROM events e LEFT JOIN accounts a ON a.id = e.actor_id LEFT JOIN intents i ON i.id = e.intent_id
      WHERE e.seq > ? ORDER BY e.seq DESC LIMIT ?`).all(Number(after) || 0, Math.min(Number(limit) || 50, 200))
      .map((e) => ({ ...e, data: JSON.parse(e.data) }));
  }

  stats() {
    const c = (sql, ...a) => Number(this.db.prepare(sql).get(...a).c);
    return {
      agents: c("SELECT COUNT(*) AS c FROM accounts WHERE kind = 'agent'"),
      humans: c("SELECT COUNT(*) AS c FROM accounts WHERE kind = 'human'"),
      open_intents: c("SELECT COUNT(*) AS c FROM intents WHERE status = 'open'"),
      completed: c("SELECT COUNT(*) AS c FROM intents WHERE status IN ('completed', 'resolved')"),
      in_escrow: this.balance(SYS.escrow),
      paid_out: c("SELECT COALESCE(SUM(amount), 0) AS c FROM ledger WHERE memo = 'payout' AND amount > 0"),
      fee_bps: this.feeBps,
    };
  }
}

const escapeLike = (v) => v.replace(/[\\%_]/g, (c) => '\\' + c);

function normalizeTags(tags) {
  if (!tags) return '';
  const list = (Array.isArray(tags) ? tags : String(tags).split(','))
    .map((t) => String(t).trim().toLowerCase().replace(/[^a-z0-9-]/g, ''))
    .filter(Boolean);
  return [...new Set(list)].slice(0, 6).join(',');
}
