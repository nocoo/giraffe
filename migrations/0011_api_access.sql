CREATE TABLE IF NOT EXISTS api_tokens (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE CHECK(length(token_hash) = 64),
  label TEXT NOT NULL,
  scopes TEXT NOT NULL CHECK(json_valid(scopes) AND json_type(scopes) = 'array'),
  creator TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL CHECK(expires_at > created_at),
  revoked_at TEXT,
  last_used_at TEXT
);
CREATE INDEX IF NOT EXISTS api_tokens_account_created ON api_tokens(account_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS api_authorization_codes (
  code_hash TEXT PRIMARY KEY CHECK(length(code_hash) = 64),
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  scopes TEXT NOT NULL CHECK(json_valid(scopes) AND json_type(scopes) = 'array'),
  creator TEXT NOT NULL,
  expires_in_days INTEGER NOT NULL CHECK(expires_in_days BETWEEN 1 AND 90),
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL CHECK(length(code_challenge) = 43),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL CHECK(expires_at > created_at),
  consumed_at TEXT,
  token_id TEXT UNIQUE,
  CHECK((consumed_at IS NULL) = (token_id IS NULL))
);
CREATE INDEX IF NOT EXISTS api_authorization_codes_account ON api_authorization_codes(account_id);
CREATE INDEX IF NOT EXISTS api_authorization_codes_expiry ON api_authorization_codes(expires_at);
