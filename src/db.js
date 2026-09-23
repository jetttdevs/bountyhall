// One SQLite file (node:sqlite). Money lives in a double-entry ledger: every
// transaction's rows sum to zero, and a balance is the sum of an account's rows.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  kind TEXT NOT NULL CHECK (kind IN ('human', 'agent', 'system')),
  bio TEXT NOT NULL DEFAULT '',
  key_hash TEXT UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ledger (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  tx_id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  amount INTEGER NOT NULL,
  memo TEXT NOT NULL,
  intent_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ledger_account ON ledger(account_id);
CREATE INDEX IF NOT EXISTS ledger_tx ON ledger(tx_id);

CREATE TABLE IF NOT EXISTS intents (
  id TEXT PRIMARY KEY,
  poster_id TEXT NOT NULL REFERENCES accounts(id),
  parent_id TEXT REFERENCES intents(id),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '',
  budget INTEGER NOT NULL,
  status TEXT NOT NULL,
  auto_award INTEGER NOT NULL DEFAULT 0,
  bid_deadline INTEGER NOT NULL,
  awarded_bid_id TEXT,
  deliver_deadline INTEGER,
  review_deadline INTEGER,
  dispute_reason TEXT,
  solver_share INTEGER,
  rating INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS intents_status ON intents(status, created_at);

CREATE TABLE IF NOT EXISTS bids (
  id TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL REFERENCES intents(id),
  solver_id TEXT NOT NULL REFERENCES accounts(id),
  price INTEGER NOT NULL,
  eta_hours INTEGER NOT NULL,
  pitch TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (intent_id, solver_id)
);

CREATE TABLE IF NOT EXISTS deliveries (
  id TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL REFERENCES intents(id),
  solver_id TEXT NOT NULL REFERENCES accounts(id),
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS verdicts (
  id TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL REFERENCES intents(id),
  judge TEXT NOT NULL,
  solver_share INTEGER NOT NULL,
  rationale TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS receipts (
  id TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL REFERENCES intents(id),
  payload TEXT NOT NULL,
  signature TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS wallets (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id),
  address TEXT NOT NULL UNIQUE,
  linked_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS wallet_challenges (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id),
  address TEXT NOT NULL,
  message TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS deposits (
  id TEXT PRIMARY KEY,
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  block_number INTEGER NOT NULL,
  from_address TEXT NOT NULL,
  raw_amount TEXT NOT NULL,
  credited INTEGER NOT NULL,
  account_id TEXT REFERENCES accounts(id),
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS deposits_from ON deposits(from_address, status);

CREATE TABLE IF NOT EXISTS withdrawals (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  to_address TEXT NOT NULL,
  amount INTEGER NOT NULL,
  raw_amount TEXT NOT NULL,
  status TEXT NOT NULL,
  tx_hash TEXT,
  nonce INTEGER,
  raw_tx TEXT,
  error TEXT,
  note TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS withdrawals_status ON withdrawals(status, created_at);

CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  intent_id TEXT,
  actor_id TEXT,
  data TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
`;

export function openDb(file = process.env.BOUNTYHALL_DB || 'data/bountyhall.db') {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

// Additive migrations for databases created by earlier versions.
function migrate(db) {
  const cols = new Set(db.prepare('PRAGMA table_info(accounts)').all().map((c) => c.name));
  if (!cols.has('webhook_url')) db.exec('ALTER TABLE accounts ADD COLUMN webhook_url TEXT');
}

// Run fn inside one IMMEDIATE transaction; roll back on any throw.
export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
