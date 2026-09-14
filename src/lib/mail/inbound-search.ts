import type { InboundEmailMeta } from "./mailbox-store";

/**
 * Legacy D1 FTS5 search index over inbound mail (`RELAYBASE_INBOX_INDEX`,
 * now superseded by `relaybase-mail` / `mailbox_fts` — see `server/db/mail/`).
 *
 * Only `MIN_SEARCH_QUERY_LENGTH` is still used by routes; the FTS helpers
 * below are retained for reference but are not wired (routes use
 * `searchMailbox` from `server/db/mail/search.ts`).
 */

const TABLE = "inbound_search_fts";

export type InboundSearchOptions = {
  domains: string[];
  q: string;
  limit?: number;
  /** Cursor: `{receivedAt}|{id}` (same shape as the R2 list cursor). */
  before?: string;
  /** Restrict to messages addressed to this account (To + Cc membership). */
  account?: string;
};

export type InboundSearchPage = {
  messages: InboundEmailMeta[];
  total: number;
  nextBefore: string | null;
  hasMore: boolean;
};

const MAX_SEARCH_LIMIT = 200;
export const MIN_SEARCH_QUERY_LENGTH = 2;
/** Cap indexed body text; full bodies stay in R2 meta.json. */
const MAX_BODY_TEXT = 100_000;

/**
 * Build a safe FTS5 MATCH expression from raw user input: split on
 * whitespace, quote each token (doubling embedded quotes) and add a `*`
 * prefix-match suffix. Tokens are implicitly ANDed by FTS5.
 * Returns null when there is nothing searchable.
 */
export function buildFtsMatchQuery(raw: string): string | null {
  const tokens = raw
    .trim()
    .split(/\s+/)
    .map((token) => token.replace(/"/g, '""'))
    // Tokens that are only FTS separators (e.g. `*`) would produce an
    // empty phrase — drop them.
    .filter((token) => /[^\s*]/.test(token));
  if (tokens.length === 0) return null;
  return tokens.map((token) => `"${token}"*`).join(" ");
}

type SearchRow = {
  id: string;
  domain: string;
  subject: string;
  from_email: string;
  from_name: string | null;
  to_email: string;
  to_emails: string | null;
  cc_emails: string | null;
  body_preview: string;
  received_at: string;
  message_id: string | null;
  in_reply_to: string | null;
  refs: string | null;
  size: number;
  attachment_count: number;
  read_at: string | null;
};

function splitAddressList(value: string | null): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function joinAddressList(value: string[] | undefined): string {
  return (value ?? []).map((entry) => entry.trim()).filter(Boolean).join(",");
}

/** Lowercased To + Cc membership list used for exact account filtering. */
function recipientsColumn(meta: InboundEmailMeta): string {
  const addresses = new Set<string>();
  const add = (value: string | null | undefined) => {
    const trimmed = value?.trim().toLowerCase();
    if (trimmed) addresses.add(trimmed);
  };
  add(meta.toEmail);
  for (const to of meta.toEmails ?? []) add(to);
  for (const cc of meta.ccEmails ?? []) add(cc);
  return [...addresses].join(",");
}

function rowToMeta(row: SearchRow): InboundEmailMeta {
  return {
    id: row.id,
    domain: row.domain,
    fromEmail: row.from_email,
    fromName: row.from_name ?? undefined,
    toEmail: row.to_email,
    toEmails: splitAddressList(row.to_emails),
    ccEmails: splitAddressList(row.cc_emails),
    subject: row.subject,
    receivedAt: row.received_at,
    messageId: row.message_id,
    inReplyTo: row.in_reply_to,
    references: row.refs,
    size: row.size,
    bodyPreview: row.body_preview,
    bodyText: "",
    bodyHtml: null,
    // Search hits only need the count for list rendering; the detail view
    // loads real attachment metadata from R2.
    attachments: Array.from({ length: row.attachment_count }, (_, index) => ({
      id: String(index),
      filename: "",
      contentType: "application/octet-stream",
      size: 0,
      disposition: "attachment",
      contentId: null,
    })),
    readAt: row.read_at,
  };
}

/**
 * Insert (or replace) the search row for one message. FTS5 tables have no
 * unique constraint, so replace = delete-by-id + insert in one batch.
 */
export async function upsertSearchRows(
  db: D1Database,
  metas: InboundEmailMeta[],
): Promise<void> {
  if (metas.length === 0) return;
  const statements: D1PreparedStatement[] = [];
  for (const meta of metas) {
    statements.push(
      db.prepare(`DELETE FROM ${TABLE} WHERE id = ?`).bind(meta.id),
    );
    statements.push(
      db
        .prepare(
          `INSERT INTO ${TABLE} (
            id, domain, subject, from_email, from_name, to_email, to_emails,
            cc_emails, recipients, body_text, body_preview, received_at,
            message_id, in_reply_to, refs, size, attachment_count, read_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          meta.id,
          meta.domain,
          meta.subject,
          meta.fromEmail,
          meta.fromName ?? null,
          meta.toEmail,
          joinAddressList(meta.toEmails),
          joinAddressList(meta.ccEmails),
          recipientsColumn(meta),
          (meta.bodyText ?? "").slice(0, MAX_BODY_TEXT),
          meta.bodyPreview,
          meta.receivedAt,
          meta.messageId,
          meta.inReplyTo,
          meta.references,
          meta.size,
          meta.attachments?.length ?? 0,
          meta.readAt ?? null,
        ),
    );
  }
  await db.batch(statements);
}

export async function deleteSearchRows(
  db: D1Database,
  ids: string[],
): Promise<void> {
  if (ids.length === 0) return;
  await db.batch(
    ids.map((id) => db.prepare(`DELETE FROM ${TABLE} WHERE id = ?`).bind(id)),
  );
}

/**
 * Remove D1 search rows for a domain that no longer have a matching R2
 * `meta.json` (e.g. messages pruned while a D1 delete failed silently).
 * `keepIds` is the set of live message ids for the domain; anything in D1
 * for this domain but not in that set is deleted. Best-effort — a failure
 * must not break the rebuild path.
 */
export async function deleteOrphanSearchRows(
  db: D1Database,
  domain: string,
  keepIds: string[],
): Promise<void> {
  const keep = new Set(keepIds);
  if (keep.size === 0) {
    await db.prepare(`DELETE FROM ${TABLE} WHERE domain = ?`).bind(domain);
    return;
  }
  const result = await db
    .prepare(`SELECT id FROM ${TABLE} WHERE domain = ?`)
    .bind(domain)
    .all();
  const rows = (result.results ?? []) as { id: string }[];
  const orphanIds = rows.map((r) => r.id).filter((id) => !keep.has(id));
  if (orphanIds.length === 0) return;
  await deleteSearchRows(db, orphanIds);
}

export async function updateSearchReadState(
  db: D1Database,
  ids: string[],
  readAt: string | null,
): Promise<void> {
  if (ids.length === 0) return;
  await db.batch(
    ids.map((id) =>
      db
        .prepare(`UPDATE ${TABLE} SET read_at = ? WHERE id = ?`)
        .bind(readAt, id),
    ),
  );
}

function parseSearchCursor(
  before: string | undefined,
): { receivedAt: string; id: string | null } | null {
  const raw = before?.trim();
  if (!raw) return null;
  const sep = raw.lastIndexOf("|");
  if (sep <= 0) return { receivedAt: raw, id: null };
  return { receivedAt: raw.slice(0, sep), id: raw.slice(sep + 1) || null };
}

/**
 * Full-text search over the inbound index. Results are flat messages (no
 * thread grouping) sorted `receivedAt` desc, paginated with the same
 * `{receivedAt}|{id}` cursor as the R2 list. `total` counts every match
 * regardless of the cursor.
 */
export async function searchInboundEmails(
  db: D1Database,
  options: InboundSearchOptions,
): Promise<InboundSearchPage> {
  const domains = options.domains
    .map((domain) => domain.trim().toLowerCase())
    .filter(Boolean);
  const match = buildFtsMatchQuery(options.q);
  if (domains.length === 0 || !match) {
    return { messages: [], total: 0, nextBefore: null, hasMore: false };
  }

  const limit = Math.min(Math.max(options.limit ?? 50, 1), MAX_SEARCH_LIMIT);
  const cursor = parseSearchCursor(options.before);
  const account = options.account?.trim().toLowerCase() || null;

  const domainPlaceholders = domains.map(() => "?").join(", ");
  const conditions = [
    `${TABLE} MATCH ?`,
    `domain IN (${domainPlaceholders})`,
  ];
  const baseParams: unknown[] = [match, ...domains];
  if (account) {
    conditions.push(`(',' || recipients || ',') LIKE ?`);
    baseParams.push(`%,${account},%`);
  }

  const countSql = `SELECT COUNT(*) AS total FROM ${TABLE} WHERE ${conditions.join(" AND ")}`;
  const countParams = [...baseParams];

  const pageConditions = [...conditions];
  const pageParams = [...baseParams];
  if (cursor) {
    if (cursor.id) {
      pageConditions.push(
        `(received_at < ? OR (received_at = ? AND id < ?))`,
      );
      pageParams.push(cursor.receivedAt, cursor.receivedAt, cursor.id);
    } else {
      pageConditions.push(`received_at < ?`);
      pageParams.push(cursor.receivedAt);
    }
  }
  const pageSql = `SELECT id, domain, subject, from_email, from_name, to_email, to_emails,
      cc_emails, body_preview, received_at, message_id, in_reply_to, refs,
      size, attachment_count, read_at
    FROM ${TABLE}
    WHERE ${pageConditions.join(" AND ")}
    ORDER BY received_at DESC, id DESC
    LIMIT ?`;
  pageParams.push(limit + 1);

  const [countResult, pageResult] = await db.batch([
    db.prepare(countSql).bind(...countParams),
    db.prepare(pageSql).bind(...pageParams),
  ]);

  const total = Number(
    (countResult.results?.[0] as { total?: number } | undefined)?.total ?? 0,
  );
  const rows = (pageResult.results ?? []) as SearchRow[];
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];

  return {
    messages: page.map(rowToMeta),
    total,
    nextBefore: hasMore && last ? `${last.received_at}|${last.id}` : null,
    hasMore,
  };
}
