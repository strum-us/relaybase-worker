/**
 * `relaybase-logs` schema.
 *
 * Matches `server/db/log/migrations/0001_ops_logs.sql` exactly — this file only
 * re-declares the existing table for Drizzle so query helpers are typed. Do
 * NOT generate a fresh CREATE from this schema; the table already exists on
 * every install that bound `RELAYBASE_LOGS`.
 */
import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const opsLog = sqliteTable("ops_log", {
  id: text("id").primaryKey(),
  at: text("at").notNull(),
  kind: text("kind").notNull(),
  ok: integer("ok").notNull(),
  status: integer("status"),
  source: text("source"),
  domain: text("domain"),
  fromAddr: text("from_addr"),
  toAddr: text("to_addr"),
  subject: text("subject"),
  messageId: text("message_id"),
  error: text("error"),
  keyId: text("key_id"),
  keyPrefix: text("key_prefix"),
  metaJson: text("meta_json"),
});

export type OpsLogRow = typeof opsLog.$inferSelect;
export type OpsLogInsert = typeof opsLog.$inferInsert;

/** Indexes mirrored from the existing migration for documentation only. */
export const opsLogIndexes = {
  atDesc: sql`CREATE INDEX IF NOT EXISTS ops_log_at_idx ON ops_log (at DESC)`,
  okAtDesc: sql`CREATE INDEX IF NOT EXISTS ops_log_ok_idx ON ops_log (ok, at DESC)`,
  domain: sql`CREATE INDEX IF NOT EXISTS ops_log_domain_idx ON ops_log (domain)`,
  kindAtDesc: sql`CREATE INDEX IF NOT EXISTS ops_log_kind_idx ON ops_log (kind, at DESC)`,
};
