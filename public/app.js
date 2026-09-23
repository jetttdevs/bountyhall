// Browser side: keeps the API key in localStorage, drives the forms, renders the
// viewer-specific actions on an intent page, and streams the live feed.
const KEY = 'bountyhall.key';
const store = {
  get() { try { return localStorage.getItem(KEY) || ''; } catch { return ''; } },
  set(v) { try { v ? localStorage.setItem(KEY, v) : localStorage.removeItem(KEY); } catch {} },
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const UNIT = document.querySelector('meta[name="bh-unit"]')?.content || 'cr';
const cr = (n) => `<span class="cr">${Number(n).toLocaleString('en-US')} ${esc(UNIT)}</span>`;
const $ = (s, el = document) => el.querySelector(s);

async function api(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  const key = store.get();
  if (key) headers.Authorization = `Bearer ${key}`;
  const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `request failed (${res.status})`);
  return data;
}

function formData(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name || el.name === '_action') continue;
    if (el.type === 'checkbox') out[el.name] = el.checked;
    else if (el.type === 'number') out[el.name] = el.value === '' ? undefined : Number(el.value);
    else out[el.name] = el.value;
  }
  return out;
}

let me = null;
async function loadMe() {
  if (!store.get()) return null;
  try { me = await api('GET', '/api/me'); } catch { me = null; }
  const slot = $('#whoami');
  if (slot && me) slot.innerHTML = `<a href="/me" class="me-chip">${esc(me.name)} · ${cr(me.balance)}</a>`;
  return me;
}

const actions = {
  async join(data) {
    const out = await api('POST', '/api/accounts', data);
    store.set(out.api_key);
    const box = $('#key-out');
    box.classList.remove('hidden');
    box.innerHTML = `<h2>Welcome, ${esc(out.account.name)}</h2><p>Your API key (shown once, saved in this browser):</p><pre class="code">${esc(out.api_key)}</pre><p>You have ${cr(out.account.balance)} to start. <a href="${out.account.kind === 'agent' ? '/intents' : '/post'}">${out.account.kind === 'agent' ? 'Find work →' : 'Post an intent →'}</a></p>`;
    await loadMe();
    return 'keep';
  },
  async 'use-key'(data) {
    store.set(data.key.trim());
    if (!(await loadMe())) { store.set(''); throw new Error('that key did not work'); }
    location.href = '/me';
  },
  async profile(data) {
    await api('PATCH', '/api/me', { bio: data.bio, webhook_url: data.webhook_url || null });
    location.reload();
  },
  async 'post-intent'(data) {
    const out = await api('POST', '/api/intents', data);
    location.href = `/i/${out.id}`;
  },
};

document.addEventListener('submit', async (ev) => {
  const form = ev.target.closest('[data-form]');
  if (!form) return;
  ev.preventDefault();
  const err = $('[data-err]', form);
  if (err) err.textContent = '';
  const btn = $('button[type=submit]', form);
  if (btn) btn.disabled = true;
  try {
    const action = form.elements._action?.value;
    const result = actions[action] ? await actions[action](formData(form), form) : await intentAction(action, formData(form));
    if (result === 'keep') form.reset();
  } catch (e) {
    if (err) err.textContent = e.message;
  } finally {
    if (btn) btn.disabled = false;
  }
});

// ---------- intent page ----------
const page = $('[data-intent]');
async function intentAction(action, data) {
  const id = page.dataset.intent;
  const map = {
    bid: ['POST', 'bids'], withdraw: ['DELETE', 'bids'], award: ['POST', 'award'], deliver: ['POST', 'deliver'],
    accept: ['POST', 'accept'], reject: ['POST', 'reject'], cancel: ['POST', 'cancel'],
  };
  const [method, path] = map[action];
  if (action === 'cancel' && !confirm('Cancel this intent and refund the budget?')) return;
  await api(method, `/api/intents/${id}/${path}`, method === 'POST' ? data : undefined);
  location.reload();
}

function f(action, inner, label, cls = 'btn') {
  return `<form data-form class="stack"><input type="hidden" name="_action" value="${action}">${inner}<button class="${cls}" type="submit">${label}</button><p class="err" data-err></p></form>`;
}

async function renderActions() {
  if (!page) return;
  const box = $('#actions');
  const id = page.dataset.intent;
  if (!store.get()) {
    box.classList.remove('hidden');
    box.innerHTML = `<p class="muted"><a href="/join">Join</a> to bid on or manage this intent.</p>`;
    return;
  }
  const i = await api('GET', `/api/intents/${id}`);
  const parts = [];
  if (i.viewer_role === 'poster') {
    if (i.status === 'open') {
      parts.push(`<h2>Sealed bids (${i.bids.length})</h2>`);
      parts.push(i.bids.length ? `<div class="table-wrap"><table><thead><tr><th>Solver</th><th>Price</th><th>ETA</th><th>Rep</th><th>Pitch</th><th></th></tr></thead><tbody>${i.bids.map((b) => `<tr><td><a href="/u/${esc(b.solver_name)}">${esc(b.solver_name)}</a></td><td>${cr(b.price)}</td><td>${b.eta_hours}h</td><td>${b.solver_reputation.toFixed(2)}</td><td class="pitch">${esc(b.pitch)}</td><td>${f('award', `<input type="hidden" name="bid_id" value="${esc(b.id)}">`, 'Award', 'btn small')}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">No bids yet. They will appear here the moment they land.</p>');
      if (i.bids.length) parts.push(f('award', '', 'Auto-award best bid (price × reputation)', 'btn ghost'));
      parts.push(f('cancel', '', 'Cancel intent and refund', 'btn danger'));
    }
    if (i.status === 'delivered') {
      parts.push('<h2>Review the delivery</h2>');
      parts.push(f('accept', `<label>Rating<select name="rating"><option value="5">5 — excellent</option><option value="4">4</option><option value="3">3</option><option value="2">2</option><option value="1">1 — poor</option></select></label>`, 'Accept and pay'));
      parts.push(f('reject', `<label>What is wrong?<textarea name="reason" rows="3" minlength="10" required></textarea></label>`, 'Dispute', 'btn danger'));
    }
    if (i.status === 'disputed') parts.push('<p class="muted">The judge is reviewing this dispute.</p>');
  } else if (i.viewer_role === 'solver') {
    if (i.status === 'awarded') {
      parts.push(`<h2>You won this at ${cr(i.winner.price)}</h2>`);
      parts.push(f('deliver', `<label>Your delivery<textarea name="content" rows="10" required></textarea></label>`, 'Deliver'));
      parts.push(`<p class="small muted">Need help? Post a subcontract with <code>parent_id: "${esc(i.id)}"</code> via the API.</p>`);
    }
  } else if (i.bidding_open) {
    parts.push(`<h2>${i.my_bid ? 'Update your sealed bid' : 'Place a sealed bid'}</h2>`);
    parts.push(f('bid', `<div class="row gap wrap-row"><label>Price (credits)<input name="price" type="number" min="1" max="${i.budget}" required value="${i.my_bid?.price ?? i.budget}"></label><label>ETA (hours)<input name="eta_hours" type="number" min="1" max="720" required value="${i.my_bid?.eta_hours ?? 24}"></label></div><label>Pitch<textarea name="pitch" rows="4" minlength="10" required>${esc(i.my_bid?.pitch ?? '')}</textarea></label>`, i.my_bid ? 'Update bid' : 'Place bid'));
    if (i.my_bid) parts.push(f('withdraw', '', 'Withdraw bid', 'btn ghost'));
  } else if (i.my_bid) {
    parts.push(`<p class="muted">Your bid: ${cr(i.my_bid.price)} — ${esc(i.my_bid.status)}.</p>`);
  }
  if (i.delivery && !i.delivery.hidden && !$('.delivery')) parts.unshift(`<h2>Delivery</h2><pre class="delivery">${esc(i.delivery.content)}</pre>`);
  if (parts.length) { box.classList.remove('hidden'); box.innerHTML = parts.join(''); }
}

// ---------- account page ----------
async function renderMe() {
  const box = $('#me');
  if (!box) return;
  if (!me) { box.innerHTML = '<p><a href="/join">Join or add your API key</a> to see your account.</p>'; return; }
  const [{ entries }, mine] = await Promise.all([api('GET', '/api/me/ledger'), api('GET', '/api/me/intents')]);
  const list = (xs) => xs.length ? `<ul>${xs.map((i) => `<li><a href="/i/${esc(i.id)}">${esc(i.title)}</a> — ${esc(i.status)} · ${cr(i.budget)}</li>`).join('')}</ul>` : '<p class="muted">None yet.</p>';
  box.innerHTML = `<section class="stats"><div><b>${me.balance.toLocaleString('en-US')}</b><span>balance</span></div><div><b>${me.reputation.earned}</b><span>earned</span></div><div><b>${me.reputation.score.toFixed(3)}</b><span>reputation</span></div></section>
  <p><a href="/u/${esc(me.name)}">Public profile</a> · <button class="btn small ghost" id="logout">Forget key</button></p>
  <section class="panel"><h2>Profile and webhook</h2>
  <form data-form class="stack"><input type="hidden" name="_action" value="profile">
  <label>Bio<input name="bio" maxlength="280" value="${esc(me.bio)}"></label>
  <label>Webhook URL (https) — we POST signed events when you win, get paid, receive bids or deliveries<input name="webhook_url" type="url" value="${esc(me.webhook_url || '')}" placeholder="https://example.com/bountyhall-hook"></label>
  <button class="btn" type="submit">Save</button><p class="err" data-err></p></form></section>
  <h2>Posted</h2>${list(mine.posted)}<h2>Solving</h2>${list(mine.solving)}
  <h2>Ledger</h2><div class="table-wrap"><table><thead><tr><th>When</th><th>Memo</th><th>Amount</th></tr></thead><tbody>${entries.map((l) => `<tr><td>${new Date(l.created_at).toLocaleString()}</td><td>${esc(l.memo)}${l.intent_id ? ` · <a href="/i/${esc(l.intent_id)}">intent</a>` : ''}</td><td class="${l.amount < 0 ? 'neg' : 'pos'}">${l.amount > 0 ? '+' : ''}${l.amount}</td></tr>`).join('')}</tbody></table></div>`;
  $('#logout').onclick = () => { store.set(''); location.href = '/'; };
}

// ---------- live feed ----------
function liveFeed() {
  const feed = $('#feed');
  if (!feed || !window.EventSource) return;
  const es = new EventSource('/api/stream');
  // the server renders feed items, so re-read them from the home page
  es.addEventListener('market', async () => {
    const html = await fetch('/').then((r) => r.text()).catch(() => null);
    const next = html && new DOMParser().parseFromString(html, 'text/html').querySelector('#feed');
    if (next) feed.innerHTML = next.innerHTML;
  });
}

(async () => {
  await loadMe();
  const need = $('#need-key');
  if (need && !store.get()) need.classList.remove('hidden');
  renderActions().catch((e) => { const box = $('#actions'); box.classList.remove('hidden'); box.innerHTML = `<p class="err">${esc(e.message)}</p>`; });
  renderMe().catch(() => {});
  renderWallet().catch((e) => { const box = $('#wallet'); if (box) box.innerHTML = `<p class="err">${esc(e.message)}</p>`; });
  initAdmin();
  liveFeed();
})();

// ---------- wallet (token mode) ----------
const shortAddr = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');
const toHex = (text) => '0x' + [...new TextEncoder().encode(text)].map((b) => b.toString(16).padStart(2, '0')).join('');
function eth() {
  if (!window.ethereum) throw new Error('No browser wallet found. Install MetaMask (or another EVM wallet), or link your wallet through the API.');
  return window.ethereum;
}
async function ensureChain(cfg) {
  const chainId = '0x' + Number(cfg.chain_id).toString(16);
  try {
    await eth().request({ method: 'wallet_switchEthereumChain', params: [{ chainId }] });
  } catch (err) {
    if (err.code !== 4902) throw err;
    await eth().request({ method: 'wallet_addEthereumChain', params: [{ chainId, chainName: cfg.chain_name, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: [cfg.rpc_url], blockExplorerUrls: [cfg.explorer] }] });
  }
}

async function renderWallet() {
  const box = $('#wallet');
  if (!box) return;
  const cfg = JSON.parse(box.dataset.config);
  if (!store.get()) { box.innerHTML = '<p><a href="/join">Join</a> or add your API key to use your wallet.</p>'; return; }
  const w = await api('GET', '/api/wallet');
  const tx = (h) => (h ? `<a href="${esc(cfg.explorer)}/tx/${esc(h)}">${esc(h.slice(0, 10))}…</a>` : '—');
  const when = (t) => new Date(t).toLocaleString();
  const linked = w.wallet
    ? `<p>Linked wallet: <a href="${esc(cfg.explorer)}/address/${esc(w.wallet.address)}"><code>${esc(w.wallet.address)}</code></a> <button class="btn small ghost" id="link-wallet">Change</button></p>`
    : `<p>No wallet linked yet. Link one to deposit and withdraw ${esc(cfg.symbol)}.</p><button class="btn" id="link-wallet">Connect wallet and sign</button>`;
  box.innerHTML = `
  <section class="stats"><div><b>${w.balance.toLocaleString('en-US')}</b><span>${esc(cfg.symbol)} balance</span></div></section>
  <section class="panel stack"><h2>1. Link your wallet</h2>${linked}<p class="err" id="link-err"></p>
    <p class="small muted">You sign a one-time message; no transaction and no gas. Agents: see <a href="/solver.md">solver.md</a> to link from code.</p></section>
  <section class="panel stack"><h2>2. Deposit</h2>
    ${w.wallet ? `<div class="row gap wrap-row"><label>Amount (${esc(cfg.symbol)})<input id="dep-amount" type="number" min="1" step="1" placeholder="10000"></label><button class="btn" id="deposit" ${cfg.decimals == null ? 'disabled' : ''}>Send from my wallet</button></div>
    <p class="small muted">Or send ${esc(cfg.symbol)} yourself <b>from your linked wallet</b> to <code>${esc(w.deposit_address)}</code> on ${esc(cfg.chain_name)}. It is credited after ${esc(cfg.confirmations)} confirmations.</p>` : '<p class="muted">Link a wallet first, so we know the deposit is yours.</p>'}
    <p class="err" id="dep-err"></p><p id="dep-ok" class="small"></p></section>
  <section class="panel"><h2>3. Withdraw</h2>
    ${w.wallet ? `<form data-form class="stack"><input type="hidden" name="_action" value="withdraw">
      <div class="row gap wrap-row"><label>Amount (${esc(cfg.symbol)}, minimum ${esc(cfg.min_withdrawal)})<input name="amount" type="number" min="${esc(cfg.min_withdrawal)}" step="1" required></label><button class="btn" type="submit">Request withdrawal</button></div>
      <p class="small muted">Goes to ${esc(shortAddr(w.wallet.address))} after an admin reviews it. The amount leaves your balance now and comes back if the request is rejected.</p><p class="err" data-err></p></form>` : '<p class="muted">Link a wallet first.</p>'}</section>
  <h2>Deposits</h2>
  <div class="table-wrap"><table><thead><tr><th>When</th><th>Amount</th><th>Status</th><th>Transaction</th></tr></thead><tbody>
  ${w.deposits.map((d) => `<tr><td>${when(d.created_at)}</td><td>${cr(d.credited)}</td><td>${esc(d.status)}</td><td>${tx(d.tx_hash)}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">None yet.</td></tr>'}
  </tbody></table></div>
  <h2>Withdrawals</h2>
  <div class="table-wrap"><table><thead><tr><th>When</th><th>Amount</th><th>To</th><th>Status</th><th>Transaction</th></tr></thead><tbody>
  ${w.withdrawals.map((x) => `<tr><td>${when(x.created_at)}</td><td>${cr(x.amount)}</td><td><code>${esc(shortAddr(x.to_address))}</code></td><td>${esc(x.status)}${x.note ? `<div class="small muted">${esc(x.note)}</div>` : ''}</td><td>${tx(x.tx_hash)}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">None yet.</td></tr>'}
  </tbody></table></div>`;

  $('#link-wallet').onclick = async () => {
    const err = $('#link-err'); err.textContent = '';
    try {
      const [address] = await eth().request({ method: 'eth_requestAccounts' });
      await ensureChain(cfg);
      const ch = await api('GET', `/api/wallet/challenge?address=${encodeURIComponent(address)}`);
      const signature = await eth().request({ method: 'personal_sign', params: [toHex(ch.message), address] });
      await api('POST', '/api/wallet/link', { address, signature });
      location.reload();
    } catch (e) { err.textContent = e.message; }
  };
  const dep = $('#deposit');
  if (dep) dep.onclick = async () => {
    const err = $('#dep-err'); err.textContent = ''; $('#dep-ok').textContent = '';
    try {
      const amount = Number($('#dep-amount').value);
      if (!Number.isInteger(amount) || amount < 1) throw new Error('enter a whole number of tokens');
      const [from] = await eth().request({ method: 'eth_requestAccounts' });
      if (from.toLowerCase() !== w.wallet.address.toLowerCase()) throw new Error(`switch your wallet to the linked address ${shortAddr(w.wallet.address)}`);
      await ensureChain(cfg);
      const raw = BigInt(amount) * 10n ** BigInt(cfg.decimals);
      const data = '0xa9059cbb' + w.deposit_address.slice(2).toLowerCase().padStart(64, '0') + raw.toString(16).padStart(64, '0');
      const hash = await eth().request({ method: 'eth_sendTransaction', params: [{ from, to: cfg.token, data }] });
      $('#dep-ok').innerHTML = `Sent: ${tx(hash)}. It shows up here after ${esc(cfg.confirmations)} confirmations.`;
    } catch (e) { err.textContent = e.message; }
  };
}
actions.withdraw = async (data) => {
  await api('POST', '/api/wallet/withdraw', { amount: data.amount });
  location.reload();
};

// ---------- admin desk ----------
const ADMIN_KEY = 'bountyhall.admin';
const adminStore = {
  get() { try { return sessionStorage.getItem(ADMIN_KEY) || ''; } catch { return ''; } },
  set(v) { try { v ? sessionStorage.setItem(ADMIN_KEY, v) : sessionStorage.removeItem(ADMIN_KEY); } catch {} },
};
async function adminApi(method, path, body) {
  const res = await fetch(path, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminStore.get()}` }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `request failed (${res.status})`);
  return data;
}

function initAdmin() {
  const login = $('#admin-login');
  if (!login) return;
  login.onsubmit = async (ev) => {
    ev.preventDefault();
    adminStore.set(login.elements.token.value.trim());
    try { await renderAdmin(); } catch (e) { adminStore.set(''); $('[data-err]', login).textContent = e.message; }
  };
  if (adminStore.get()) renderAdmin().catch(() => adminStore.set(''));
}

async function renderAdmin() {
  const box = $('#admin');
  const tokenMode = box.dataset.tokenMode === '1';
  const [health, { disputes }, treasury, wd] = await Promise.all([
    adminApi('GET', '/api/admin/health'),
    adminApi('GET', '/api/admin/disputes'),
    tokenMode ? adminApi('GET', '/api/admin/treasury') : null,
    tokenMode ? adminApi('GET', '/api/admin/withdrawals') : null,
  ]);
  $('#admin-login').classList.add('hidden');
  box.classList.remove('hidden');
  const when = (t) => new Date(t).toLocaleString();
  const parts = [];
  const icon = { ok: '<b class="pos">✓</b>', warn: '<b class="warnc">!</b>', error: '<b class="neg">✗</b>' };
  parts.push(`<section class="panel"><h2>Setup check ${health.ok ? '<span class="pos small">ready</span>' : '<span class="neg small">needs attention</span>'}</h2>
    <table class="checks"><tbody>${health.checks.map((c) => `<tr><td>${icon[c.level]}</td><td><b>${esc(c.item)}</b></td><td class="small">${esc(c.detail)}</td></tr>`).join('')}</tbody></table>
    <p class="small muted">Version ${esc(health.version)} · up ${Math.round(health.uptime_s / 60)} min · <button class="btn small ghost" data-admin="house">Run the house agent now</button></p></section>`);
  if (treasury) {
    const t = treasury;
    parts.push(`<section class="panel"><h2>Treasury</h2>
      <p>${t.solvent === undefined ? '<span class="err">Chain unreachable: ' + esc(t.last_error || '') + '</span>' : t.solvent ? '<b class="pos">Solvent</b>' : '<b class="neg">UNDER-COLLATERALISED</b>'} · address <code>${esc(t.address)}</code></p>
      <section class="stats">
        <div><b>${t.onchain_balance?.toLocaleString('en-US') ?? '—'}</b><span>on-chain ${esc(t.symbol)}</span></div>
        <div><b>${t.owed_total.toLocaleString('en-US')}</b><span>owed in total</span></div>
        <div><b>${t.held_by_users.toLocaleString('en-US')}</b><span>user balances</span></div>
        <div><b>${t.in_escrow.toLocaleString('en-US')}</b><span>in escrow</span></div>
        <div><b>${t.pending_withdrawals.toLocaleString('en-US')}</b><span>pending withdrawals</span></div>
        <div><b>${t.fees.toLocaleString('en-US')}</b><span>house fees</span></div>
      </section>
      <p class="small muted">Gas balance: ${t.gas_balance_wei ? (Number(BigInt(t.gas_balance_wei) / 10n ** 12n) / 1e6).toFixed(6) + ' ETH' : '—'} · unclaimed deposits: ${t.unclaimed_deposits} · unbacked signup credits: ${t.unbacked_signup_credits} · scanned to block ${esc(t.cursor_block ?? '—')}</p>
      <button class="btn small ghost" data-admin="poll">Scan the chain now</button>
      <h3>Pay out house earnings</h3>
      <div class="row gap wrap-row"><label>From<select id="payout-source"><option value="fees">house fees (${t.fees.toLocaleString('en-US')})</option><option value="house-agent">house agent earnings</option></select></label>
      <label>Amount<input id="payout-amount" type="number" min="1" step="1"></label><label>To address<input id="payout-to" placeholder="0x…"></label>
      <button class="btn small" data-admin="payout">Queue payout</button></div>
      <p class="small muted">Payouts join the withdrawal queue below; approve them there.</p></section>`);
    const open = wd.withdrawals.filter((w) => ['pending', 'signing', 'sending'].includes(w.status));
    const done = wd.withdrawals.filter((w) => !['pending', 'signing', 'sending'].includes(w.status)).slice(0, 30);
    const row = (w) => `<tr><td>${when(w.created_at)}</td><td><a href="/u/${esc(w.account_name)}">${esc(w.account_name)}</a><div class="small muted">wallet linked ${w.wallet_linked_at ? when(w.wallet_linked_at) : '—'}</div></td>
      <td>${cr(w.amount)}</td><td><code>${esc(w.to_address)}</code></td><td>${esc(w.status)}${w.error ? `<div class="small err">${esc(w.error)}</div>` : ''}${w.note ? `<div class="small muted">${esc(w.note)}</div>` : ''}</td>
      <td>${w.explorer_url ? `<a href="${esc(w.explorer_url)}">tx</a>` : ''}</td>
      <td class="stack">${w.status === 'pending' ? `<button class="btn small" data-admin="approve" data-id="${esc(w.id)}">Approve and send</button><button class="btn small danger" data-admin="reject" data-id="${esc(w.id)}">Reject</button>` : ''}
      ${w.status === 'sending' ? `<button class="btn small ghost" data-admin="rebroadcast" data-id="${esc(w.id)}">Rebroadcast</button><button class="btn small danger" data-admin="refund" data-id="${esc(w.id)}">Refund (dropped)</button>` : ''}</td></tr>`;
    const table = (xs) => `<div class="table-wrap"><table><thead><tr><th>Requested</th><th>Account</th><th>Amount</th><th>To</th><th>Status</th><th></th><th></th></tr></thead><tbody>${xs.map(row).join('') || '<tr><td colspan="7" class="muted">Nothing here.</td></tr>'}</tbody></table></div>`;
    parts.push(`<h2>Withdrawals to review (${open.length})</h2>${table(open)}<h2>Recent withdrawals</h2>${table(done)}`);
  }
  parts.push(`<h2>Disputes (${disputes.length})</h2>` + (disputes.map((d) => `<section class="panel stack"><h3><a href="/i/${esc(d.id)}">${esc(d.title)}</a> — ${cr(d.case.price)}</h3>
    <p class="small"><b>Complaint:</b> ${esc(d.case.reason)}</p><details><summary>Delivery</summary><pre class="delivery">${esc(d.case.delivery)}</pre></details>
    <div class="row gap wrap-row"><label>Solver share %<input type="number" min="0" max="100" value="50" id="share-${esc(d.id)}"></label><label>Rationale<input id="why-${esc(d.id)}" placeholder="Why this split"></label>
    <button class="btn small" data-admin="resolve" data-id="${esc(d.id)}">Rule</button></div></section>`).join('') || '<p class="muted">No open disputes.</p>'));
  parts.push('<p><button class="btn small ghost" data-admin="logout">Lock the desk</button></p>');
  box.innerHTML = parts.join('');
}

document.addEventListener('click', async (ev) => {
  const btn = ev.target.closest('[data-admin]');
  if (!btn) return;
  const { admin: action, id } = btn.dataset;
  btn.disabled = true;
  try {
    if (action === 'logout') { adminStore.set(''); location.reload(); return; }
    if (action === 'poll') await adminApi('POST', '/api/admin/chain/poll');
    if (action === 'house') { const r = await adminApi('POST', '/api/admin/house/tick'); alert(`House agent: ${r.bids ?? 0} bids, ${r.passes ?? 0} passed, ${r.deliveries ?? 0} delivered${r.error ? `, error: ${r.error}` : ''}`); }
    if (action === 'payout') await adminApi('POST', '/api/admin/payout', { source: $('#payout-source').value, amount: Number($('#payout-amount').value), to: $('#payout-to').value.trim() });
    if (action === 'approve' && confirm('Sign and send this transfer from the hot wallet?')) await adminApi('POST', `/api/admin/withdrawals/${id}/approve`);
    if (action === 'reject') { const reason = prompt('Reason for rejecting (the user sees this):'); if (reason) await adminApi('POST', `/api/admin/withdrawals/${id}/reject`, { reason }); }
    if (action === 'rebroadcast') await adminApi('POST', `/api/admin/withdrawals/${id}/rebroadcast`);
    if (action === 'refund' && confirm('Refund this withdrawal to the account? Only works if the transfer was dropped.')) await adminApi('POST', `/api/admin/withdrawals/${id}/refund`);
    if (action === 'resolve') await adminApi('POST', `/api/admin/resolve/${id}`, { solver_share: Number($(`#share-${id}`).value), rationale: $(`#why-${id}`).value || 'Ruled by an admin.' });
    await renderAdmin();
  } catch (e) {
    alert(e.message);
    btn.disabled = false;
  }
});
