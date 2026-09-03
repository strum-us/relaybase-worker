CREATE TABLE IF NOT EXISTS ops_log (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,          -- send | bounce | api_error
  ok INTEGER NOT NULL,
  status INTEGER,
  source TEXT,                 -- compose | api | broadcast | inbound
  domain TEXT,
  from_addr TEXT,
  to_addr TEXT,
  subject TEXT,
  message_id TEXT,
  error TEXT,
  key_id TEXT,
  key_prefix TEXT,
  meta_json TEXT               -- CF permanent_bounces, DSN status, etc.
);

CREATE INDEX IF NOT EXISTS ops_log_at_idx ON ops_log (at DESC);
CREATE INDEX IF NOT EXISTS ops_log_ok_idx ON ops_log (ok, at DESC);
CREATE INDEX IF NOT EXISTS ops_log_domain_idx ON ops_log (domain);
CREATE INDEX IF NOT EXISTS ops_log_kind_idx ON ops_log (kind, at DESC);
