// Browser side: keeps the API key in localStorage, drives the forms, renders the
// viewer-specific actions on an intent page, and streams the live feed.
const KEY = 'bountyhall.key';
const store = {
  get() { try { return localStorage.getItem(KEY) || ''; } catch { return ''; } },
  set(v) { try { v ? localStorage.setItem(KEY, v) : localStorage.removeItem(KEY); } catch {} },
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cr = (n) => `<span class="cr">${Number(n).toLocaleString('en-US')} cr</span>`;
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
  liveFeed();
})();
