CREATE TABLE IF NOT EXISTS repo_meta (
 account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 identity_key TEXT NOT NULL,
 created_at TEXT,
 created_at_source TEXT CHECK(created_at_source IN ('agent','catalog')),
 archived_at TEXT,
 archived_at_source TEXT CHECK(archived_at_source IN ('agent','catalog')),
 category TEXT CHECK(category IN ('app','docs-vault','profile','repro','derivative')),
 category_source TEXT CHECK(category_source IN ('agent','catalog')),
 exclusion_reason TEXT CHECK(length(exclusion_reason)<=200),
 exclusion_reason_source TEXT CHECK(exclusion_reason_source IN ('agent','catalog')),
 updated_at TEXT NOT NULL,
 PRIMARY KEY(account_id,identity_key),
 CHECK((created_at IS NULL)=(created_at_source IS NULL)),
 CHECK((archived_at IS NULL)=(archived_at_source IS NULL)),
 CHECK((category IS NULL)=(category_source IS NULL)),
 CHECK((exclusion_reason IS NULL)=(exclusion_reason_source IS NULL))
);
