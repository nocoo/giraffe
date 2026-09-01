CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  login TEXT NOT NULL,
  avatar_url TEXT NOT NULL DEFAULT '',
  token_ciphertext TEXT NOT NULL,
  token_last4 TEXT NOT NULL,
  key_version INTEGER NOT NULL DEFAULT 1,
  scopes TEXT NOT NULL DEFAULT '',
  capabilities TEXT NOT NULL DEFAULT '{}',
  is_active INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_used_at TEXT
);
CREATE UNIQUE INDEX accounts_login ON accounts (login);
CREATE UNIQUE INDEX accounts_one_active ON accounts (is_active) WHERE is_active = 1;

CREATE TABLE snapshots (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (account_id, kind)
);

CREATE TABLE snapshot_days (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (account_id, day)
);
