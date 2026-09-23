CREATE TABLE IF NOT EXISTS ai_settings (
  kind TEXT PRIMARY KEY CHECK(kind IN ('summary', 'judgment')),
  api_key_ciphertext TEXT NOT NULL,
  key_version INTEGER NOT NULL CHECK(key_version > 0),
  model TEXT NOT NULL,
  base_url TEXT NOT NULL,
  sdk_type TEXT NOT NULL CHECK(sdk_type IN ('openai', 'anthropic')),
  auth_type TEXT NOT NULL CHECK(auth_type IN ('apiKey', 'bearer')),
  updated_at TEXT NOT NULL
);
