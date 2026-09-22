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
  return db;
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
