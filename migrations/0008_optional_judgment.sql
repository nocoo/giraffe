CREATE TABLE IF NOT EXISTS ai_provider_options (
 kind TEXT PRIMARY KEY REFERENCES ai_settings(kind) ON DELETE CASCADE,
 enabled INTEGER NOT NULL CHECK(enabled IN (0,1))
);
