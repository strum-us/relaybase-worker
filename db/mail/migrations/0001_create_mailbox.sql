-- Unified mailbox D1: list/count/cursor table for inbound + sent, plus a
-- full-text search side index. R2 stays the source of truth (per-message
-- meta.json + raw.eml); this database is rebuildable from R2 via
-- POST /console/rebuild-mail.
--
-- `mailbox_messages` is the hot path for list pages, counts, and account
-- scoping. `mailbox_fts` is FTS5 over subject/from/to/cc/body_text (capped
-- excerpt only — full bodies live in R2 raw.eml).
--
-- `occurred_at` is inbound `receivedAt` or sent `sentAt`. `recipients` is the
-- lowercased To+Cc membership list (comma-joined) used for exact account
-- scoping on /mobile/inbox/search. `refs` holds the RFC `References` header
-- (`references` is a reserved word). `r2_prefix` is the R2 folder prefix
-- (`inbound|sent/{domain}/{id}`) so a row can resolve to its R2 object
-- without recomputing the key.
CREATE TABLE IF NOT EXISTS mailbox_messages (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  domain TEXT NOT NULL,
  from_email TEXT NOT NULL,
  from_name TEXT,
  to_email TEXT NOT NULL,
  to_emails TEXT,
  cc_emails TEXT,
  recipients TEXT NOT NULL,
  subject TEXT NOT NULL,
  body_preview TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  message_id TEXT,
  in_reply_to TEXT,
  refs TEXT,
  size INTEGER NOT NULL,
  attachment_count INTEGER NOT NULL,
  read_at TEXT,
  r2_prefix TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS mailbox_rfc_idx
  ON mailbox_messages (domain, kind, message_id)
  WHERE message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS mailbox_list_idx
  ON mailbox_messages (kind, domain, occurred_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS mailbox_unread_idx
  ON mailbox_messages (kind, domain, read_at)
  WHERE kind = 'inbound' AND read_at IS NULL;

CREATE INDEX IF NOT EXISTS mailbox_domain_idx
  ON mailbox_messages (domain, kind);

CREATE VIRTUAL TABLE IF NOT EXISTS mailbox_fts USING fts5(
  id UNINDEXED,
  kind UNINDEXED,
  domain UNINDEXED,
  subject,
  from_email,
  from_name,
  to_emails,
  cc_emails,
  body_text
);
