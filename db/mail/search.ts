import { sql } from "drizzle-orm";
import type { D1Database } from "@cloudflare/workers-types";
import type { MailDb } from "./index";
import type { MailboxKind, MailboxFtsRow } from "./schema";
import type { MailboxMessageRow } from "./schema";

export type MailboxSearchOptions = {
  kind?: MailboxKind;
  domains: string[];
  q: string;
  limit?: number;
  /** Cursor: `{occurred_at}|{id}` (same shape as the list cursor). */
  before?: string;
  /** Restrict to messages addressed to this account (To + Cc membership). */
  account?: string;
};

export type MailboxSearchPage = {
  rows: MailboxMessageRow[];
  total: number;
  nextBefore: string | null;
  hasMore: boolean;
};

const TABLE = "mailbox_fts";
const MAX_SEARCH_LIMIT = 200;
export const MIN_SEARCH_QUERY_LENGTH = 2;
/** Cap indexed body text; full bodies stay in R2 raw.eml. */
export const MAX_BODY_TEXT = 100_000;

/**
 * Build a safe FTS5 MATCH expression from raw user input: split on
 * whitespace, quote each token (doubling embedded quotes) and add a `*`
 * prefix-match suffix. Tokens are implicitly ANDed by FTS5.
 * Returns null when there is nothing searchable.
 */
export function buildMailboxFtsQuery(raw: string): string | null {
  const tokens = raw
    .trim()
    .split(/\s+/)
    .map((token) => token.replace(/"/g, '""'))
    .filter((token) => /[^\s*]/.test(token));
  if (tokens.length === 0) return null;
  return tokens.map((token) => `"${token}"*`).join(" ");
}

function parseSearchCursor(
  before: string | undefined,
): { occurredAt: string; id: string | null } | null {
  const raw = before?.trim();
  if (!raw) return null;
  const sep = raw.lastIndexOf("|");
  if (sep <= 0) return { occurredAt: raw, id: null };
  return { occurredAt: raw.slice(0, sep), id: raw.slice(sep + 1) || null };
}

/** Insert (or replace) the FTS row for one message. FTS5 has no unique
 * constraint, so replace = delete-by-id + insert. */
export async function upsertMailboxFts(
  db: MailDb,
  rows: Array<{ id: string; kind: MailboxKind; domain: string; subject: string; from_email: string; from_name: string | null; to_emails: string | null; cc_emails: string | null; body_text: string }>,
): Promise<void> {
  if (!db || rows.length === 0) return;
  for (const row of rows) {
    await db.run(sql`DELETE FROM ${sql.raw(TABLE)} WHERE id = ${row.id}`);
    await db.run(
      sql`INSERT INTO ${sql.raw(TABLE)} (
        id, kind, domain, subject, from_email, from_name, to_emails,
        cc_emails, body_text
      ) VALUES (
        ${row.id}, ${row.kind}, ${row.domain}, ${row.subject},
        ${row.from_email}, ${row.from_name}, ${row.to_emails},
        ${row.cc_emails}, ${(row.body_text ?? "").slice(0, MAX_BODY_TEXT)}
      )`,
    );
  }
}

export async function deleteMailboxFts(db: MailDb, ids: string[]): Promise<void> {
  if (!db || ids.length === 0) return;
  for (const id of ids) {
    await db.run(sql`DELETE FROM ${sql.raw(TABLE)} WHERE id = ${id}`);
  }
}

/**
 * Full-text search across mailbox_fts, joined back to mailbox_messages for
 * the full list row. Results are flat (no thread grouping) sorted
 * `occurred_at` desc, paginated with the same `{occurred_at}|{id}` cursor as
 * the list. `total` counts every match regardless of the cursor.
 *
 * FTS5 virtual tables cannot use the drizzle query builder, so this falls
 * back to the raw D1 client (`db.$client`) for the dynamic MATCH + IN + LIKE
 * query.
 */
export async function searchMailbox(
  db: MailDb,
  options: MailboxSearchOptions,
): Promise<MailboxSearchPage> {
  const domains = options.domains
    .map((domain) => domain.trim().toLowerCase())
    .filter(Boolean);
  const match = buildMailboxFtsQuery(options.q);
  if (!db || domains.length === 0 || !match) {
    return { rows: [], total: 0, nextBefore: null, hasMore: false };
  }

  const limit = Math.min(Math.max(options.limit ?? 50, 1), MAX_SEARCH_LIMIT);
  const cursor = parseSearchCursor(options.before);
  const account = options.account?.trim().toLowerCase() || null;
  const kind = options.kind ?? null;
  const raw: D1Database = db.$client;

  const conditions = [`${TABLE} MATCH ?`, `${TABLE}.domain IN (${domains.map(() => "?").join(", ")})`];
  const baseParams: (string | number)[] = [match, ...domains];
  if (kind) {
    conditions.push(`${TABLE}.kind = ?`);
    baseParams.push(kind);
  }
  if (account) {
    conditions.push(`(',' || mailbox_messages.recipients || ',') LIKE ?`);
    baseParams.push(`%,${account},%`);
  }

  const joinFrom = `${TABLE} INNER JOIN mailbox_messages ON ${TABLE}.id = mailbox_messages.id`;
  const countSql = `SELECT COUNT(*) AS total FROM ${joinFrom} WHERE ${conditions.join(" AND ")}`;
  const countParams = [...baseParams];

  const pageConditions = [...conditions];
  const pageParams = [...baseParams];
  if (cursor) {
    if (cursor.id) {
      pageConditions.push(
        `(mailbox_messages.occurred_at < ? OR (mailbox_messages.occurred_at = ? AND mailbox_messages.id < ?))`,
      );
      pageParams.push(cursor.occurredAt, cursor.occurredAt, cursor.id);
    } else {
      pageConditions.push(`mailbox_messages.occurred_at < ?`);
      pageParams.push(cursor.occurredAt);
    }
  }
  const pageSql = `SELECT mailbox_messages.id, mailbox_messages.kind, mailbox_messages.domain,
      mailbox_messages.from_email, mailbox_messages.from_name, mailbox_messages.to_email,
      mailbox_messages.to_emails, mailbox_messages.cc_emails, mailbox_messages.recipients,
      mailbox_messages.subject, mailbox_messages.body_preview, mailbox_messages.occurred_at,
      mailbox_messages.message_id, mailbox_messages.in_reply_to, mailbox_messages.refs,
      mailbox_messages.size, mailbox_messages.attachment_count, mailbox_messages.read_at,
      mailbox_messages.r2_prefix
    FROM ${joinFrom}
    WHERE ${pageConditions.join(" AND ")}
    ORDER BY mailbox_messages.occurred_at DESC, mailbox_messages.id DESC
    LIMIT ?`;
  pageParams.push(limit + 1);

  try {
    const [countResult, pageResult] = await Promise.all([
      raw.prepare(countSql).bind(...countParams).all<{ total: number }>(),
      raw.prepare(pageSql).bind(...pageParams).all<MailboxMessageRow>(),
    ]);

    const total = Number(countResult.results?.[0]?.total ?? 0);
    const rows = pageResult.results ?? [];
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];

    return {
      rows: page,
      total,
      nextBefore: hasMore && last ? `${last.occurred_at}|${last.id}` : null,
      hasMore,
    };
  } catch (error) {
    console.error("Failed to search mailbox", error);
    return { rows: [], total: 0, nextBefore: null, hasMore: false };
  }
}

export type { MailboxFtsRow };
