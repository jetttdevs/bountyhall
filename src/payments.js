// On-chain payments in an ERC-20 token (MUSEBOOK on Robinhood Chain by default).
//
// Custodial model: users deposit tokens to the treasury (the hot wallet), the
// watcher credits them in the internal ledger once the transfer has enough
// confirmations, and every job then settles instantly off-chain. Withdrawals
// wait in a queue until an admin approves them; only then does the server sign
// and broadcast a token transfer.
//
// Ledger: 1 credit = 1 whole token. Deposits move sys_chain -> user; a
// withdrawal request moves user -> sys_withdrawals; confirmation moves
// sys_withdrawals -> sys_chain; a rejection or refund moves it back to the user.
// So -balance(sys_chain) is always exactly what the treasury owes on-chain.
//
//   withdrawal: pending ─approve─▶ signing ─▶ sending ─mined─▶ confirmed
//                  │                   │          ├─reverted─▶ failed   (refunded)
//                  └─reject─▶ rejected └─error─▶ pending        └─dropped─▶ refunded
import { randomBytes } from 'node:crypto';
import { getAddress, isAddress } from 'viem';
import { tx } from './db.js';
import { SYS } from './market.js';
import { HttpError, newId, now, int, str, MINUTE } from './util.js';

export const DEFAULTS = {
  rpcUrl: 'https://rpc.mainnet.chain.robinhood.com',
  chainId: 4663,
  chainName: 'Robinhood Chain',
  token: '0x91A2DAe9699f0B82540B5886b0d8759C22820bA3',
  symbol: 'MUSEBOOK',
  explorer: 'https://robinhoodchain.blockscout.com',
  confirmations: 20,
  minWithdrawal: 1000,
};

export function paymentsConfigFromEnv(env = process.env) {
  const mode = (env.PAYMENTS || 'credits').toLowerCase();
  if (mode !== 'token') return { mode: 'credits' };
  return {
    mode: 'token',
    rpcUrl: env.CHAIN_RPC_URL || DEFAULTS.rpcUrl,
    chainId: Number(env.CHAIN_ID || DEFAULTS.chainId),
    chainName: env.CHAIN_NAME || DEFAULTS.chainName,
    token: env.TOKEN_ADDRESS || DEFAULTS.token,
    symbol: env.TOKEN_SYMBOL || DEFAULTS.symbol,
    explorer: (env.EXPLORER_URL || DEFAULTS.explorer).replace(/\/$/, ''),
    confirmations: Number(env.CONFIRMATIONS || DEFAULTS.confirmations),
    minWithdrawal: Number(env.MIN_WITHDRAWAL || DEFAULTS.minWithdrawal),
    maxWithdrawalPerDay: Number(env.MAX_WITHDRAWAL_PER_DAY || 0),
    fromBlock: env.WATCH_FROM_BLOCK ? BigInt(env.WATCH_FROM_BLOCK) : null,
    privateKey: env.HOT_WALLET_PRIVATE_KEY || null,
    depositAddress: env.DEPOSIT_ADDRESS || null,
  };
}

const CHALLENGE_TTL = 10 * MINUTE;
const SCAN_CHUNK = 2000n;
const OPEN_WITHDRAWALS = ['pending', 'signing', 'sending'];

export class Payments {
  constructor(market, chain, cfg, { log = console } = {}) {
    this.market = market;
    this.db = market.db;
    this.chain = chain;
    this.cfg = cfg;
    this.log = log;
    this.ready = false;
    this.decimals = null;
    this.lastError = null;
    this.queue = Promise.resolve(); // serializes signing so nonces never collide
  }

  // ---------- setup ----------
  async init() {
    // A crash between claiming a withdrawal and recording its signed hash leaves
    // it in 'signing'. Nothing was broadcast (the hash is stored first), so it
    // is safe to put it back in the queue.
    const stuck = this.db.prepare("UPDATE withdrawals SET status = 'pending', error = 'interrupted before signing; back in the queue', updated_at = ? WHERE status = 'signing' AND tx_hash IS NULL").run(now());
    if (stuck.changes) this.log.warn?.(`[payments] ${stuck.changes} interrupted withdrawal(s) returned to the queue`);
    try {
      const info = await this.chain.check();
      this.decimals = info.decimals;
      this.onchainSymbol = info.symbol;
      this.ready = true;
      this.lastError = null;
      if (info.symbol !== this.cfg.symbol) this.log.warn?.(`[payments] token symbol on-chain is ${info.symbol}, configured ${this.cfg.symbol}`);
      const unbacked = this.market.balance(SYS.faucet);
      if (unbacked !== 0) this.log.warn?.(`[payments] ${-unbacked} free signup credits exist that no token backs; set SIGNUP_CREDITS=0 in token mode`);
    } catch (err) {
      this.ready = false;
      this.lastError = err.message;
      this.log.error?.(`[payments] chain check failed: ${err.message}`);
    }
    return this.ready;
  }

  #needReady() {
    if (!this.ready) throw new HttpError(503, `payments are temporarily unavailable: ${this.lastError || 'chain not checked yet'}`, 'chain_unavailable');
  }

  unit() { return 10n ** BigInt(this.decimals); }

  publicConfig() {
    return {
      mode: 'token', symbol: this.cfg.symbol, token: this.chain.token, chain_id: this.cfg.chainId, chain_name: this.cfg.chainName,
      rpc_url: this.cfg.rpcUrl, explorer: this.cfg.explorer, decimals: this.decimals, deposit_address: this.chain.treasury,
      confirmations: this.cfg.confirmations, min_withdrawal: this.cfg.minWithdrawal, max_withdrawal_per_day: this.cfg.maxWithdrawalPerDay || null,
      withdrawals: 'reviewed by an admin', ready: this.ready,
    };
  }

  // ---------- wallets ----------
  wallet(accountId) {
    return this.db.prepare('SELECT address, linked_at FROM wallets WHERE account_id = ?').get(accountId) || null;
  }

  challenge(me, address) {
    if (typeof address !== 'string' || !isAddress(address)) throw new HttpError(400, 'address must be a 0x wallet address', 'invalid_input');
    const addr = getAddress(address);
    const expires = now() + CHALLENGE_TTL;
    const message = [
      'Bountyhall wallet link',
      `Account: ${me.name} (${me.id})`,
      `Address: ${addr}`,
      `Chain: ${this.cfg.chainId}`,
      `Nonce: ${randomBytes(16).toString('hex')}`,
      `Expires: ${new Date(expires).toISOString()}`,
    ].join('\n');
    this.db.prepare('INSERT OR REPLACE INTO wallet_challenges (account_id, address, message, expires_at) VALUES (?, ?, ?, ?)').run(me.id, addr, message, expires);
    return { address: addr, message, expires_at: expires };
  }

  async link(me, { address, signature }) {
    if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]+$/.test(signature)) throw new HttpError(400, 'signature must be a 0x hex string', 'invalid_input');
    if (typeof address !== 'string' || !isAddress(address)) throw new HttpError(400, 'address must be a 0x wallet address', 'invalid_input');
    const addr = getAddress(address);
    const ch = this.db.prepare('SELECT * FROM wallet_challenges WHERE account_id = ?').get(me.id);
    if (!ch || ch.address !== addr) throw new HttpError(400, 'request a challenge for this address first', 'no_challenge');
    if (now() > ch.expires_at) throw new HttpError(400, 'the challenge expired; request a new one', 'challenge_expired');
    // single use: a challenge is spent by any attempt, right or wrong
    this.db.prepare('DELETE FROM wallet_challenges WHERE account_id = ?').run(me.id);
    let valid = false;
    try { valid = await this.chain.verify(addr, ch.message, signature); } catch { valid = false; }
    if (!valid) throw new HttpError(400, 'signature does not match the address', 'bad_signature');
    return tx(this.db, () => {
      const owner = this.db.prepare('SELECT account_id FROM wallets WHERE address = ?').get(addr);
      if (owner && owner.account_id !== me.id) throw new HttpError(409, 'that wallet is linked to another account', 'wallet_taken');
      const open = this.db.prepare(`SELECT COUNT(*) AS c FROM withdrawals WHERE account_id = ? AND status IN (${OPEN_WITHDRAWALS.map(() => '?').join(',')})`).get(me.id, ...OPEN_WITHDRAWALS).c;
      if (open) throw new HttpError(409, 'you cannot change wallets while a withdrawal is open', 'withdrawal_open');
      this.db.prepare('INSERT INTO wallets (account_id, address, linked_at) VALUES (?, ?, ?) ON CONFLICT(account_id) DO UPDATE SET address = excluded.address, linked_at = excluded.linked_at').run(me.id, addr, now());
      // deposits that arrived from this address before it was linked
      const claimed = this.db.prepare("SELECT * FROM deposits WHERE from_address = ? AND status = 'unclaimed'").all(addr);
      for (const d of claimed) this.#credit(d, me.id);
      return { address: addr, linked_at: now(), claimed_deposits: claimed.length, claimed_amount: claimed.reduce((a, d) => a + d.credited, 0) };
    });
  }

  #credit(d, accountId) {
    this.market.transfer([[SYS.chain, -d.credited], [accountId, d.credited]], 'deposit');
    this.db.prepare("UPDATE deposits SET status = 'credited', account_id = ? WHERE id = ?").run(accountId, d.id);
  }

  // ---------- deposits ----------
  #recordDeposit(log) {
    const credited = log.value / this.unit();
    if (credited > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`deposit too large to credit: ${log.value}`);
    const id = newId('dep');
    const from = getAddress(log.from);
    const r = this.db.prepare(`INSERT OR IGNORE INTO deposits (id, tx_hash, log_index, block_number, from_address, raw_amount, credited, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'new', ?)`).run(id, log.txHash, Number(log.logIndex), Number(log.blockNumber), from, log.value.toString(), Number(credited), now());
    if (!r.changes) return false; // already seen
    const d = this.db.prepare('SELECT * FROM deposits WHERE id = ?').get(id);
    if (d.credited === 0) { this.db.prepare("UPDATE deposits SET status = 'dust' WHERE id = ?").run(id); return true; }
    const owner = this.db.prepare('SELECT account_id FROM wallets WHERE address = ?').get(from);
    if (owner) this.#credit(d, owner.account_id);
    else this.db.prepare("UPDATE deposits SET status = 'unclaimed' WHERE id = ?").run(id);
    return true;
  }

  async scanDeposits() {
    const head = await this.chain.head();
    const safe = head - BigInt(this.cfg.confirmations);
    if (safe < 0n) return 0;
    const stored = this.db.prepare("SELECT v FROM meta WHERE k = 'chain_cursor'").get()?.v;
    let cursor = stored != null ? BigInt(stored) : (this.cfg.fromBlock != null ? this.cfg.fromBlock - 1n : safe);
    if (stored == null) this.db.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('chain_cursor', ?)").run(cursor.toString());
    let found = 0;
    while (cursor < safe) {
      const to = cursor + SCAN_CHUNK < safe ? cursor + SCAN_CHUNK : safe;
      const logs = await this.chain.transfersTo(cursor + 1n, to);
      tx(this.db, () => {
        for (const log of logs) if (this.#recordDeposit(log)) found++;
        this.db.prepare("UPDATE meta SET v = ? WHERE k = 'chain_cursor'").run(to.toString());
      });
      cursor = to;
    }
    return found;
  }

  deposits(accountId, limit = 50) {
    return this.db.prepare('SELECT id, tx_hash, block_number, from_address, raw_amount, credited, status, created_at FROM deposits WHERE account_id = ? ORDER BY created_at DESC LIMIT ?').all(accountId, limit);
  }

  // ---------- withdrawals ----------
  requestWithdrawal(me, input) {
    this.#needReady();
    const amount = int(input.amount, 'amount', { min: this.cfg.minWithdrawal, max: Number.MAX_SAFE_INTEGER });
    return tx(this.db, () => {
      const w = this.wallet(me.id);
      if (!w) throw new HttpError(409, 'link a wallet first; withdrawals only go to your linked wallet', 'no_wallet');
      if (this.market.balance(me.id) < amount) throw new HttpError(402, 'insufficient balance', 'insufficient_funds');
      if (this.cfg.maxWithdrawalPerDay) {
        const used = Number(this.db.prepare("SELECT COALESCE(SUM(amount), 0) AS s FROM withdrawals WHERE account_id = ? AND created_at > ? AND status NOT IN ('rejected', 'failed', 'refunded')").get(me.id, now() - 24 * 60 * MINUTE).s);
        if (used + amount > this.cfg.maxWithdrawalPerDay) throw new HttpError(429, `daily withdrawal limit is ${this.cfg.maxWithdrawalPerDay}; ${Math.max(0, this.cfg.maxWithdrawalPerDay - used)} left in the last 24 hours`, 'daily_limit');
      }
      const id = newId('wd');
      const t = now();
      this.db.prepare(`INSERT INTO withdrawals (id, account_id, to_address, amount, raw_amount, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`).run(id, me.id, w.address, amount, (BigInt(amount) * this.unit()).toString(), t, t);
      this.market.transfer([[me.id, -amount], [SYS.withdrawals, amount]], 'withdrawal requested');
      return this.withdrawal(id);
    });
  }

  // Operator payout: move house fees (or another system-owned account, like the
  // house agent's earnings) to any address. Goes through the same review queue.
  requestOperatorWithdrawal(accountId, { amount, to }) {
    this.#needReady();
    const n = int(amount, 'amount', { min: 1, max: Number.MAX_SAFE_INTEGER });
    if (typeof to !== 'string' || !isAddress(to)) throw new HttpError(400, 'to must be a 0x wallet address', 'invalid_input');
    return tx(this.db, () => {
      if (this.market.balance(accountId) < n) throw new HttpError(402, `that account holds ${this.market.balance(accountId)}`, 'insufficient_funds');
      const id = newId('wd');
      const t = now();
      this.db.prepare(`INSERT INTO withdrawals (id, account_id, to_address, amount, raw_amount, status, note, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'pending', 'operator payout', ?, ?)`).run(id, accountId, getAddress(to), n, (BigInt(n) * this.unit()).toString(), t, t);
      this.market.transfer([[accountId, -n], [SYS.withdrawals, n]], 'operator payout requested');
      return this.withdrawal(id);
    });
  }

  withdrawal(id) {
    const w = this.db.prepare('SELECT w.*, a.name AS account_name FROM withdrawals w JOIN accounts a ON a.id = w.account_id WHERE w.id = ?').get(id);
    if (!w) throw new HttpError(404, 'withdrawal not found', 'not_found');
    const { raw_tx, ...rest } = w;
    return { ...rest, explorer_url: w.tx_hash ? `${this.cfg.explorer}/tx/${w.tx_hash}` : null };
  }

  withdrawals({ accountId, status, limit = 100 } = {}) {
    const where = []; const args = [];
    if (accountId) where.push('account_id = ?'), args.push(accountId);
    if (status) where.push('status = ?'), args.push(status);
    const ids = this.db.prepare(`SELECT id FROM withdrawals ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT ?`).all(...args, limit);
    return ids.map((r) => this.withdrawal(r.id));
  }

  #setWithdrawal(id, fields) {
    const cols = Object.keys(fields);
    this.db.prepare(`UPDATE withdrawals SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...cols.map((c) => fields[c]), now(), id);
  }

  #refund(w, status, note) {
    this.market.transfer([[SYS.withdrawals, -w.amount], [w.account_id, w.amount]], `withdrawal ${status}`);
    this.#setWithdrawal(w.id, { status, note });
  }

  reject(id, reason) {
    const why = str(reason, 'reason', { min: 3, max: 500 });
    return tx(this.db, () => {
      const w = this.db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(id);
      if (!w) throw new HttpError(404, 'withdrawal not found', 'not_found');
      if (w.status !== 'pending') throw new HttpError(409, `cannot reject a withdrawal that is ${w.status}`, 'invalid_state');
      this.#refund(w, 'rejected', why);
      return this.withdrawal(id);
    });
  }

  // Approve: claim the row, then sign and broadcast one at a time.
  approve(id) {
    this.#needReady();
    if (!this.chain.canSend) throw new HttpError(503, 'no hot wallet key is configured, so withdrawals cannot be sent', 'no_hot_wallet');
    const w = tx(this.db, () => {
      const row = this.db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(id);
      if (!row) throw new HttpError(404, 'withdrawal not found', 'not_found');
      if (row.status !== 'pending') throw new HttpError(409, `cannot approve a withdrawal that is ${row.status}`, 'invalid_state');
      this.#setWithdrawal(id, { status: 'signing', error: null });
      return row;
    });
    const job = this.queue.then(() => this.#send(w));
    this.queue = job.catch(() => {});
    return job;
  }

  async #send(w) {
    let signed;
    try {
      const raw = BigInt(w.raw_amount);
      const have = await this.chain.tokenBalance(this.chain.treasury);
      if (have < raw) throw new Error(`hot wallet holds ${have / this.unit()} ${this.cfg.symbol}, needs ${w.amount}`);
      signed = await this.chain.signTransfer(w.to_address, raw);
    } catch (err) {
      // nothing left the building: put it back in the queue
      this.#setWithdrawal(w.id, { status: 'pending', error: err.shortMessage || err.message });
      throw new HttpError(502, `could not sign the transfer: ${err.shortMessage || err.message}`, 'send_failed');
    }
    // record the hash before broadcasting, so a crash can never lose track of a sent transfer
    this.#setWithdrawal(w.id, { status: 'sending', tx_hash: signed.hash, nonce: signed.nonce, raw_tx: signed.raw });
    try {
      await this.chain.broadcast(signed.raw);
    } catch (err) {
      this.#setWithdrawal(w.id, { error: `broadcast failed: ${err.shortMessage || err.message}` });
    }
    return this.withdrawal(w.id);
  }

  async rebroadcast(id) {
    const w = this.db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(id);
    if (!w) throw new HttpError(404, 'withdrawal not found', 'not_found');
    if (w.status !== 'sending') throw new HttpError(409, 'only withdrawals that are sending can be rebroadcast', 'invalid_state');
    try { await this.chain.broadcast(w.raw_tx); this.#setWithdrawal(id, { error: null }); } catch (err) {
      this.#setWithdrawal(id, { error: `rebroadcast failed: ${err.shortMessage || err.message}` });
    }
    return this.withdrawal(id);
  }

  // Refund a transfer that will never be mined: it is unknown to the chain and
  // its nonce has already been used by another transaction.
  async refundDropped(id) {
    const w = this.db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(id);
    if (!w) throw new HttpError(404, 'withdrawal not found', 'not_found');
    if (w.status !== 'sending') throw new HttpError(409, 'only withdrawals that are sending can be refunded', 'invalid_state');
    if (await this.chain.receipt(w.tx_hash)) throw new HttpError(409, 'that transfer was mined; wait for the watcher to settle it', 'mined');
    if (await this.chain.txExists(w.tx_hash)) throw new HttpError(409, 'that transfer is still pending on-chain', 'still_pending');
    if ((await this.chain.confirmedNonce()) <= w.nonce) throw new HttpError(409, 'its nonce is unused, so it could still be mined: rebroadcast it instead', 'nonce_unused');
    return tx(this.db, () => {
      const row = this.db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(id);
      if (row.status !== 'sending') throw new HttpError(409, `withdrawal is ${row.status}`, 'invalid_state');
      this.#refund(row, 'refunded', 'transfer was dropped; refunded to the account');
      return this.withdrawal(id);
    });
  }

  async trackWithdrawals() {
    const sending = this.db.prepare("SELECT * FROM withdrawals WHERE status = 'sending'").all();
    if (!sending.length) return 0;
    const head = await this.chain.head();
    let settled = 0;
    for (const w of sending) {
      const r = await this.chain.receipt(w.tx_hash);
      if (!r || head - r.blockNumber < BigInt(this.cfg.confirmations)) continue;
      tx(this.db, () => {
        const row = this.db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(w.id);
        if (row.status !== 'sending') return;
        if (r.status === 'success') {
          this.market.transfer([[SYS.withdrawals, -row.amount], [SYS.chain, row.amount]], 'withdrawal sent');
          this.#setWithdrawal(row.id, { status: 'confirmed', error: null });
        } else {
          this.#refund(row, 'failed', 'the transfer reverted on-chain; refunded to the account');
        }
      });
      settled++;
    }
    return settled;
  }

  async poll() {
    if (!this.ready && !(await this.init())) return { ready: false };
    try {
      const deposits = await this.scanDeposits();
      const withdrawals = await this.trackWithdrawals();
      this.lastError = null;
      return { ready: true, deposits, withdrawals };
    } catch (err) {
      this.lastError = err.shortMessage || err.message;
      this.log.error?.(`[payments] poll failed: ${this.lastError}`);
      return { ready: true, error: this.lastError };
    }
  }

  // ---------- solvency ----------
  async treasury() {
    const owed = -this.market.balance(SYS.chain);
    const out = {
      address: this.chain.treasury, symbol: this.cfg.symbol, ready: this.ready, last_error: this.lastError,
      owed_total: owed, held_by_users: null, in_escrow: this.market.balance(SYS.escrow), fees: this.market.balance(SYS.fees),
      pending_withdrawals: this.market.balance(SYS.withdrawals), unbacked_signup_credits: -this.market.balance(SYS.faucet),
      unclaimed_deposits: Number(this.db.prepare("SELECT COALESCE(SUM(credited), 0) AS s FROM deposits WHERE status = 'unclaimed'").get().s),
      cursor_block: this.db.prepare("SELECT v FROM meta WHERE k = 'chain_cursor'").get()?.v ?? null,
    };
    out.held_by_users = owed - out.in_escrow - out.fees - out.pending_withdrawals;
    if (this.ready) {
      const [tokens, gas] = await Promise.all([this.chain.tokenBalance(this.chain.treasury), this.chain.nativeBalance(this.chain.treasury)]);
      out.onchain_balance = Number(tokens / this.unit());
      out.gas_balance_wei = gas.toString();
      out.solvent = out.onchain_balance >= owed;
      out.surplus = out.onchain_balance - owed;
    }
    return out;
  }
}
