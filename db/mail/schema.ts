/**
 * `relaybase-mail` schema.
 *
 * `mailbox_messages` is the list/count/cursor table for inbound + sent mail.
 * `mailbox_fts` is an FTS5 virtual table created by
 * `server/db/mail/migrations/0001_create_mailbox.sql`. Drizzle cannot model
 * FTS5 columns as a regular `sqliteTable`, so this module only exposes a
 * typed row shape + a `sql` fragment for the table name used in raw queries.
 * Do NOT generate a fresh CREATE from this schema.
 */
import { sql } from "drizzle-orm";

export const mailboxFts = sql.identifier("mailbox_fts");

export type MailboxKind = "inbound" | "sent";

export type MailboxMessageRow = {
  id: string;
  kind: MailboxKind;
  domain: string;
  from_email: string;
  from_name: string | null;
  to_email: string;
  to_emails: string | null;
  cc_emails: string | null;
  recipients: string;
  subject: string;
  body_preview: string;
  occurred_at: string;
  message_id: string | null;
  in_reply_to: string | null;
  refs: string | null;
  size: number;
  attachment_count: number;
  read_at: string | null;
  r2_prefix: string;
};

export type MailboxFtsRow = {
  id: string;
  kind: MailboxKind;
  domain: string;
  subject: string;
  from_email: string;
  from_name: string | null;
  to_emails: string | null;
  cc_emails: string | null;
  body_text: string;
};
