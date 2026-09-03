/**
 * Embedded D1 migrations — the Worker owns its own schema.
 *
 * SQL files live next to each D1 module:
 *   db/app/migrations/*.sql
 *   db/log/migrations/*.sql
 *   db/mail/migrations/*.sql
 *
 * The desktop creates the D1 databases and deploys the Worker, then calls
 * POST /console/init-db. The Worker applies these strings. Desktop never
 * runs wrangler d1 migrations apply or raw SQL.
 *
 * To add a migration: add the .sql file under the matching db module, then
 * add the file content as a string below so the Worker and wrangler stay
 * in sync.
 */

export type MigrationTarget = "app" | "logs" | "mail";

export type Migration = {
  target: MigrationTarget;
  name: string;
  sql: string;
};

const APP_0000 = `CREATE TABLE \`domains\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`domain\` text NOT NULL,
	\`created_at\` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX \`domains_domain_unique\` ON \`domains\` (\`domain\`);
--> statement-breakpoint
CREATE TABLE \`addresses\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`email\` text NOT NULL,
	\`domain\` text NOT NULL,
	\`display_name\` text,
	\`signature\` text,
	\`inbound_enabled\` integer DEFAULT 1 NOT NULL,
	\`mobile_enabled\` integer DEFAULT 1 NOT NULL,
	\`created_at\` text NOT NULL,
	FOREIGN KEY (\`domain\`) REFERENCES \`domains\`(\`id\`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX \`addresses_email_unique\` ON \`addresses\` (\`email\`);
--> statement-breakpoint
CREATE INDEX \`addresses_domain_idx\` ON \`addresses\` (\`domain\`);
--> statement-breakpoint
CREATE TABLE \`api_keys\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`key_hash\` text NOT NULL,
	\`domain\` text NOT NULL,
	\`label\` text,
	\`key_prefix\` text NOT NULL,
	\`created_at\` text NOT NULL,
	\`active\` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX \`api_keys_key_hash_unique\` ON \`api_keys\` (\`key_hash\`);
--> statement-breakpoint
CREATE INDEX \`api_keys_domain_idx\` ON \`api_keys\` (\`domain\`);
--> statement-breakpoint
CREATE INDEX \`api_keys_active_idx\` ON \`api_keys\` (\`active\`);
--> statement-breakpoint
CREATE TABLE \`app_settings\` (
	\`id\` integer PRIMARY KEY NOT NULL,
	\`inbound_retain_per_domain\` integer,
	\`updated_at\` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE \`audience_groups\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`name\` text NOT NULL,
	\`domain\` text NOT NULL,
	\`created_at\` text NOT NULL,
	\`default_from\` text,
	\`data_source_json\` text,
	\`cron_enabled\` integer DEFAULT 0 NOT NULL,
	\`cron_interval_minutes\` integer,
	\`last_sync_at\` text,
	\`last_sync_status\` text,
	\`last_sync_error\` text,
	\`last_sync_count\` integer,
	\`sync_progress_json\` text,
	\`sync_history_json\` text
);
--> statement-breakpoint
CREATE INDEX \`audience_groups_domain_idx\` ON \`audience_groups\` (\`domain\`);
--> statement-breakpoint
CREATE TABLE \`audience_contacts\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`email\` text NOT NULL,
	\`name\` text,
	\`domain\` text NOT NULL,
	\`group_id\` text NOT NULL,
	\`source\` text NOT NULL,
	\`added_at\` text NOT NULL,
	FOREIGN KEY (\`group_id\`) REFERENCES \`audience_groups\`(\`id\`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX \`audience_contacts_group_email_idx\` ON \`audience_contacts\` (\`group_id\`,\`email\`);
--> statement-breakpoint
CREATE INDEX \`audience_contacts_group_idx\` ON \`audience_contacts\` (\`group_id\`);
--> statement-breakpoint
CREATE INDEX \`audience_contacts_domain_idx\` ON \`audience_contacts\` (\`domain\`);
--> statement-breakpoint
CREATE TABLE \`broadcasts\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`subject\` text NOT NULL,
	\`status\` text NOT NULL,
	\`created_at\` text NOT NULL,
	\`domain\` text NOT NULL,
	\`group_ids_json\` text NOT NULL,
	\`from_addr\` text,
	\`body\` text,
	\`recipient_count\` integer,
	\`sent_at\` text,
	\`send_progress_json\` text,
	\`send_history_json\` text
);
--> statement-breakpoint
CREATE INDEX \`broadcasts_domain_idx\` ON \`broadcasts\` (\`domain\`);
--> statement-breakpoint
CREATE INDEX \`broadcasts_status_idx\` ON \`broadcasts\` (\`status\`);
--> statement-breakpoint
CREATE INDEX \`broadcasts_created_at_idx\` ON \`broadcasts\` (\`created_at\`);
--> statement-breakpoint
CREATE TABLE \`domain_branding\` (
	\`domain\` text PRIMARY KEY NOT NULL,
	\`dmarc_policy\` text DEFAULT 'quarantine' NOT NULL,
	\`dmarc_rua\` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE \`inbound_events\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`domain\` text NOT NULL,
	\`event_type\` text NOT NULL,
	\`created_at\` text NOT NULL,
	\`payload_json\` text NOT NULL,
	\`expires_at\` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX \`inbound_events_domain_idx\` ON \`inbound_events\` (\`domain\`);
--> statement-breakpoint
CREATE INDEX \`inbound_events_expires_idx\` ON \`inbound_events\` (\`expires_at\`);
--> statement-breakpoint
CREATE TABLE \`mobile_passwords\` (
	\`email\` text PRIMARY KEY NOT NULL,
	\`password_hash\` text NOT NULL,
	\`salt\` text NOT NULL,
	\`updated_at\` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE \`owner_config\` (
	\`id\` integer PRIMARY KEY NOT NULL,
	\`owner_email\` text,
	\`worker_url\` text,
	\`passtoken_salt\` text,
	\`passtoken_hash\` text,
	\`passtoken_prefix\` text,
	\`passtoken_updated_at\` text,
	\`cf_account_id\` text
);
--> statement-breakpoint
CREATE TABLE \`owner_sessions\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`token_hash\` text NOT NULL,
	\`family\` text NOT NULL,
	\`label\` text,
	\`created_at\` text NOT NULL,
	\`expires_at\` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX \`owner_sessions_token_hash_unique\` ON \`owner_sessions\` (\`token_hash\`);
--> statement-breakpoint
CREATE INDEX \`owner_sessions_family_idx\` ON \`owner_sessions\` (\`family\`);
--> statement-breakpoint
CREATE TABLE \`webhooks\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`domain\` text NOT NULL,
	\`url\` text NOT NULL,
	\`secret_hash\` text NOT NULL,
	\`created_at\` text NOT NULL,
	\`active\` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE INDEX \`webhooks_domain_idx\` ON \`webhooks\` (\`domain\`);
--> statement-breakpoint
CREATE INDEX \`webhooks_active_idx\` ON \`webhooks\` (\`active\`);
--> statement-breakpoint
CREATE TABLE \`webhook_fails\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`webhook_id\` text NOT NULL,
	\`event_id\` text NOT NULL,
	\`url\` text NOT NULL,
	\`failed_at\` text NOT NULL,
	\`expires_at\` text NOT NULL,
	FOREIGN KEY (\`webhook_id\`) REFERENCES \`webhooks\`(\`id\`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX \`webhook_fails_webhook_idx\` ON \`webhook_fails\` (\`webhook_id\`);
--> statement-breakpoint
CREATE INDEX \`webhook_fails_expires_idx\` ON \`webhook_fails\` (\`expires_at\`);
--> statement-breakpoint
CREATE TABLE \`webhook_secrets\` (
	\`webhook_id\` text PRIMARY KEY NOT NULL,
	\`secret\` text NOT NULL,
	FOREIGN KEY (\`webhook_id\`) REFERENCES \`webhooks\`(\`id\`) ON UPDATE no action ON DELETE cascade
);
`;

const LOGS_0001 = `CREATE TABLE IF NOT EXISTS ops_log (
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
`;

const MAIL_0001 = `-- Unified mailbox D1: list/count/cursor table for inbound + sent, plus a
-- full-text search side index. R2 stays the source of truth (per-message
-- meta.json + raw.eml); this database is rebuildable from R2 via
-- POST /console/rebuild-mail.
--
-- \`mailbox_messages\` is the hot path for list pages, counts, and account
-- scoping. \`mailbox_fts\` is FTS5 over subject/from/to/cc/body_text (capped
-- excerpt only — full bodies live in R2 raw.eml).
--
-- \`occurred_at\` is inbound \`receivedAt\` or sent \`sentAt\`. \`recipients\` is the
-- lowercased To+Cc membership list (comma-joined) used for exact account
-- scoping on /mobile/inbox/search. \`refs\` holds the RFC \`References\` header
-- (\`references\` is a reserved word). \`r2_prefix\` is the R2 folder prefix
-- (\`inbound|sent/{domain}/{id}\`) so a row can resolve to its R2 object
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
`;

export const MIGRATIONS: Migration[] = [
  { target: "app", name: "0000_normal_terrax", sql: APP_0000 },
  { target: "logs", name: "0001_ops_logs", sql: LOGS_0001 },
  { target: "mail", name: "0001_create_mailbox", sql: MAIL_0001 },
];

/** Split a Drizzle migration on `--> statement-breakpoint` into statements. */
export function splitMigrationSql(sql: string): string[] {
  return sql
    .split("--> statement-breakpoint")
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && !isCommentOnly(part));
}

function isCommentOnly(sql: string): boolean {
  return sql
    .split("\n")
    .every((line) => line.trim() === "" || line.trim().startsWith("--"));
}
