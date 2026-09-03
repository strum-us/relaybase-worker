import { sql } from "drizzle-orm";
import type { D1Database } from "@cloudflare/workers-types";
import type { MailDb } from "./index";
import type { MailboxKind, MailboxMessageRow } from "./schema";

export type MailboxListFilters = {
  kind: MailboxKind;
  domain: string;
  /** Cursor: `{occurred_at}|{id}`. */
  before?: string;
  limit?: number;
  /** Restrict to messages addressed to this account (To + Cc membership). */
  account?: string;
};

export type MailboxListPage = {
  rows: MailboxMessageRow[];
  nextBefore: string | null;
  hasMore: boolean;
  /** Total retained messages for the domain+kind (whole table, not this page). */
  total: number;
  /** Unread messages for the domain+kind (inbound only; sent is always 0). */
  unread: number;
};

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export function parseMailboxCursor(
  before: string | undefined,
): { occurredAt: string; id: string | null } | null {
  const raw = before?.trim();
  if (!raw) return null;
  const sep = raw.lastIndexOf("|");
  if (sep <= 0) return { occurredAt: raw, id: null };
  return { occurredAt: raw.slice(0, sep), id: raw.slice(sep + 1) || null };
}

export function encodeMailboxCursor(row: { occurred_at: string; id: string }): string {
  return `${row.occurred_at}|${row.id}`;
}

/** Lowercased To + Cc membership list used for exact account filtering. */
export function recipientsColumn(input: {
  toEmail: string;
  toEmails?: string[];
  ccEmails?: string[];
}): string {
  const addresses = new Set<string>();
  const add = (value: string | null | undefined) => {
    const trimmed = value?.trim().toLowerCase();
    if (trimmed) addresses.add(trimmed);
  };
  add(input.toEmail);
  for (const to of input.toEmails ?? []) add(to);
  for (const cc of input.ccEmails ?? []) add(cc);
  return [...addresses].join(",");
}

export type UpsertMailboxMessageInput = Omit<
  MailboxMessageRow,
  "recipients"
> & {
  recipients?: string;
  toEmails?: string[];
  ccEmails?: string[];
};

/** Insert or replace a mailbox_messages row. Idempotent on (id). */
export async function upsertMailboxMessage(
  db: MailDb,
  input: UpsertMailboxMessageInput,
): Promise<void> {
  if (!db) return;
  const recipients =
    input.recipients ??
    recipientsColumn({
      toEmail: input.to_email,
      toEmails: input.to_emails ? splitAddressList(input.to_emails) : undefined,
      ccEmails: input.cc_emails ? splitAddressList(input.cc_emails) : undefined,
    });
  await db.run(sql`
    INSERT INTO mailbox_messages (
      id, kind, domain, from_email, from_name, to_email, to_emails,
      cc_emails, recipients, subject, body_preview, occurred_at,
      message_id, in_reply_to, refs, size, attachment_count, read_at, r2_prefix
    ) VALUES (
      ${input.id}, ${input.kind}, ${input.domain}, ${input.from_email},
      ${input.from_name}, ${input.to_email}, ${input.to_emails},
      ${input.cc_emails}, ${recipients}, ${input.subject},
      ${input.body_preview}, ${input.occurred_at}, ${input.message_id},
      ${input.in_reply_to}, ${input.refs}, ${input.size},
      ${input.attachment_count}, ${input.read_at}, ${input.r2_prefix}
    )
    ON CONFLICT(id) DO UPDATE SET
      kind = excluded.kind,
      domain = excluded.domain,
      from_email = excluded.from_email,
      from_name = excluded.from_name,
      to_email = excluded.to_email,
      to_emails = excluded.to_emails,
      cc_emails = excluded.cc_emails,
      recipients = excluded.recipients,
      subject = excluded.subject,
      body_preview = excluded.body_preview,
      occurred_at = excluded.occurred_at,
      message_id = excluded.message_id,
      in_reply_to = excluded.in_reply_to,
      refs = excluded.refs,
      size = excluded.size,
      attachment_count = excluded.attachment_count,
      read_at = excluded.read_at,
      r2_prefix = excluded.r2_prefix
  `);
}

export async function deleteMailboxMessages(
  db: MailDb,
  ids: string[],
): Promise<void> {
  if (!db || ids.length === 0) return;
  for (const id of ids) {
    await db.run(sql`DELETE FROM mailbox_messages WHERE id = ${id}`);
  }
}

export async function updateMailboxReadState(
  db: MailDb,
  ids: string[],
  readAt: string | null,
): Promise<void> {
  if (!db || ids.length === 0) return;
  for (const id of ids) {
    await db.run(
      sql`UPDATE mailbox_messages SET read_at = ${readAt} WHERE id = ${id} AND kind = 'inbound'`,
    );
  }
}

function splitAddressList(value: string | null): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export type MailboxCounts = {
  total: number;
  unread: number;
};

/** All indexed ids for a domain+kind — used by rebuild to resume after a timeout. */
export async function mailboxIdsForDomain(
  db: MailDb,
  kind: MailboxKind,
  domain: string,
): Promise<Set<string>> {
  const ids = new Set<string>();
  if (!db) return ids;
  const raw: D1Database = db.$client;
  const rows = await raw
    .prepare(`SELECT id FROM mailbox_messages WHERE kind = ? AND domain = ?`)
    .bind(kind, domain)
    .all<{ id: string }>();
  for (const row of rows.results ?? []) {
    if (row.id) ids.add(row.id);
  }
  return ids;
}

export async function mailboxCounts(
  db: MailDb,
  kind: MailboxKind,
  domain: string,
): Promise<MailboxCounts> {
  if (!db) return { total: 0, unread: 0 };
  const raw: D1Database = db.$client;
  const [totalRow, unreadRow] = await Promise.all([
    raw
      .prepare(
        `SELECT COUNT(*) AS total FROM mailbox_messages WHERE kind = ? AND domain = ?`,
      )
      .bind(kind, domain)
      .first<{ total: number }>(),
    kind === "inbound"
      ? raw
          .prepare(
            `SELECT COUNT(*) AS total FROM mailbox_messages
             WHERE kind = 'inbound' AND domain = ? AND read_at IS NULL`,
          )
          .bind(domain)
          .first<{ total: number }>()
      : Promise.resolve({ total: 0 }),
  ]);
  return {
    total: Number(totalRow?.total ?? 0),
    unread: Number(unreadRow?.total ?? 0),
  };
}

/** Per-address counts (To + Cc membership) for the dashboard sidebar. */
export async function mailboxAddressCounts(
  db: MailDb,
  kind: MailboxKind,
  domain: string,
): Promise<Record<string, MailboxCounts>> {
  if (!db) return {};
  const raw: D1Database = db.$client;
  const rows = await raw
    .prepare(
      `SELECT recipients, read_at FROM mailbox_messages
       WHERE kind = ? AND domain = ?`,
    )
    .bind(kind, domain)
    .all<{ recipients: string; read_at: string | null }>();
  const out: Record<string, MailboxCounts> = {};
  for (const row of rows.results ?? []) {
    const addresses = (row.recipients ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
    const unread = kind === "inbound" && !row.read_at;
    for (const address of addresses) {
      const bucket = out[address] ?? { total: 0, unread: 0 };
      bucket.total += 1;
      if (unread) bucket.unread += 1;
      out[address] = bucket;
    }
  }
  return out;
}

/** Newest `occurred_at` per (kind, domain) — used for the dashboard freshness probe. */
export async function mailboxFreshness(
  db: MailDb,
): Promise<Array<{ kind: MailboxKind; domain: string; last_at: string | null; count: number }>> {
  if (!db) return [];
  const raw: D1Database = db.$client;
  const rows = await raw
    .prepare(
      `SELECT kind, domain, MAX(occurred_at) AS last_at, COUNT(*) AS count
       FROM mailbox_messages GROUP BY kind, domain`,
    )
    .all<{ kind: MailboxKind; domain: string; last_at: string | null; count: number }>();
  return rows.results ?? [];
}

export async function listMailboxPage(
  db: MailDb,
  filters: MailboxListFilters,
): Promise<MailboxListPage> {
  if (!db) {
    return { rows: [], nextBefore: null, hasMore: false, total: 0, unread: 0 };
  }
  const domain = filters.domain.trim().toLowerCase();
  const limit = Math.min(
    Math.max(filters.limit ?? DEFAULT_LIMIT, 1),
    MAX_LIMIT,
  );
  const cursor = parseMailboxCursor(filters.before);
  const account = filters.account?.trim().toLowerCase() || null;
  const raw: D1Database = db.$client;

  const conditions = ["kind = ?", "domain = ?"];
  const params: (string | number)[] = [filters.kind, domain];
  if (account) {
    conditions.push("(',' || recipients || ',') LIKE ?");
    params.push(`%,${account},%`);
  }
  if (cursor) {
    if (cursor.id) {
      conditions.push(
        "(occurred_at < ? OR (occurred_at = ? AND id < ?))",
      );
      params.push(cursor.occurredAt, cursor.occurredAt, cursor.id);
    } else {
      conditions.push("occurred_at < ?");
      params.push(cursor.occurredAt);
    }
  }

  const where = conditions.join(" AND ");
  const pageSql = `SELECT id, kind, domain, from_email, from_name, to_email, to_emails,
      cc_emails, recipients, subject, body_preview, occurred_at, message_id,
      in_reply_to, refs, size, attachment_count, read_at, r2_prefix
    FROM mailbox_messages
    WHERE ${where}
    ORDER BY occurred_at DESC, id DESC
    LIMIT ?`;
  const pageParams = [...params, limit + 1];

  const countSql = `SELECT COUNT(*) AS total FROM mailbox_messages WHERE kind = ? AND domain = ?${
    account ? " AND (',' || recipients || ',') LIKE ?" : ""
  }`;
  const countParams: (string | number)[] = [filters.kind, domain];
  if (account) countParams.push(`%,${account},%`);

  const unreadSql =
    filters.kind === "inbound"
      ? `SELECT COUNT(*) AS total FROM mailbox_messages
         WHERE kind = 'inbound' AND domain = ? AND read_at IS NULL${
           account ? " AND (',' || recipients || ',') LIKE ?" : ""
         }`
      : null;
  const unreadParams: (string | number)[] = [domain];
  if (account && unreadSql) unreadParams.push(`%,${account},%`);

  const [pageResult, countResult, unreadResult] = await Promise.all([
    raw.prepare(pageSql).bind(...pageParams).all<MailboxMessageRow>(),
    raw.prepare(countSql).bind(...countParams).first<{ total: number }>(),
    unreadSql
      ? raw.prepare(unreadSql).bind(...unreadParams).first<{ total: number }>()
      : Promise.resolve({ total: 0 }),
  ]);

  const rows = pageResult.results ?? [];
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];

  return {
    rows: page,
    nextBefore: hasMore && last ? encodeMailboxCursor(last) : null,
    hasMore,
    total: Number(countResult?.total ?? 0),
    unread: Number(unreadResult?.total ?? 0),
  };
}

/**
 * Resolve R2 folder ids for retention pruning (rows past the newest `keep`).
 * When `limit` is set, only that many ids are returned (newest-beyond-cap
 * first) so a cron tick cannot delete thousands of prefixes in one isolate.
 */
export async function mailboxPruneIds(
  db: MailDb,
  kind: MailboxKind,
  domain: string,
  keep: number,
  limit?: number,
): Promise<string[]> {
  if (!db || keep <= 0) return [];
  const raw: D1Database = db.$client;
  if (limit != null && limit > 0) {
    const rows = await raw
      .prepare(
        `SELECT id FROM mailbox_messages
         WHERE kind = ? AND domain = ?
         ORDER BY occurred_at DESC, id DESC
         LIMIT ? OFFSET ?`,
      )
      .bind(kind, domain, limit, keep)
      .all<{ id: string }>();
    return (rows.results ?? []).map((row) => row.id);
  }
  const rows = await raw
    .prepare(
      `SELECT id FROM mailbox_messages
       WHERE kind = ? AND domain = ?
       ORDER BY occurred_at DESC, id DESC
       LIMIT -1 OFFSET ?`,
    )
    .bind(kind, domain, keep)
    .all<{ id: string }>();
  return (rows.results ?? []).map((row) => row.id);
}
