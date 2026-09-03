import type { Env } from "../../env";
import { createAppDb } from "../../../db/app";
import { createMailDb } from "../../../db/mail";
import {
  ackPendingEvents,
  listPendingEvents,
  type InboundEmailEvent,
} from "../inbound-events";
import {
  getInboundAttachment,
  getMailMessage,
  setMailReadState,
  type InboundEmailMeta,
} from "../mailbox-store";
import {
  listMailboxPage,
  mailboxAddressCounts,
  type MailboxListPage,
} from "../../../db/mail/messages";
import {
  searchMailbox,
  type MailboxSearchPage,
} from "../../../db/mail/search";
import {
  serializeInboundListItem,
  serializeInboundMessage,
} from "../inbound-serialize";

export type InboxListItem = ReturnType<typeof serializeInboundListItem>;
export type InboxMessage = ReturnType<typeof serializeInboundMessage>;

export type ListInboxOptions = {
  /** Filter to a single recipient address (lowercased). */
  account?: string;
  limit?: number;
};

export type InboxListPage = {
  messages: InboxListItem[];
  total: number;
  unread: number;
};

function rowToInboundMeta(
  row: MailboxListPage["rows"][number],
): InboundEmailMeta {
  return {
    id: row.id,
    domain: row.domain,
    fromEmail: row.from_email,
    fromName: row.from_name ?? undefined,
    toEmail: row.to_email,
    toEmails: row.to_emails ? row.to_emails.split(",").filter(Boolean) : [],
    ccEmails: row.cc_emails ? row.cc_emails.split(",").filter(Boolean) : [],
    subject: row.subject,
    receivedAt: row.occurred_at,
    messageId: row.message_id,
    inReplyTo: row.in_reply_to,
    references: row.refs,
    size: row.size,
    bodyPreview: row.body_preview,
    bodyText: "",
    bodyHtml: null,
    attachments: Array.from({ length: row.attachment_count }, (_, i) => ({
      id: String(i),
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
 * List inbox messages across multiple domains (mobile "all inboxes" view),
 * optionally filtered to a single recipient address. Newest first, capped at
 * `limit`. Reads from D1 `mailbox_messages` (no R2 `_list.json`).
 */
export async function listInboxForDomains(
  env: Env,
  domains: string[],
  options: ListInboxOptions = {},
): Promise<InboxListPage> {
  const mailDb = createMailDb(env.RELAYBASE_MAIL);
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const account = options.account?.trim().toLowerCase() || undefined;

  const collected: InboundEmailMeta[] = [];
  let total = 0;
  let unread = 0;
  for (const domain of domains) {
    const normalized = domain.trim().toLowerCase();
    if (!normalized) continue;
    if (!mailDb) continue;
    const page = await listMailboxPage(mailDb, {
      kind: "inbound",
      domain: normalized,
      account,
      limit,
    });
    total += page.total;
    unread += page.unread;
    for (const row of page.rows) {
      collected.push(rowToInboundMeta(row));
    }
  }

  collected.sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
  return {
    messages: collected.slice(0, limit).map(serializeInboundListItem),
    total,
    unread,
  };
}

/**
 * Full-text search across the supplied domains, optionally scoped to one
 * recipient account (mobile). Returns null when the mail index binding is
 * not configured.
 */
export async function searchInboxForDomains(
  env: Env,
  domains: string[],
  options: { q: string; limit?: number; before?: string; account?: string },
): Promise<MailboxSearchPage | null> {
  const mailDb = createMailDb(env.RELAYBASE_MAIL);
  if (!mailDb) return null;
  return searchMailbox(mailDb, {
    kind: "inbound",
    domains,
    q: options.q,
    limit: options.limit,
    before: options.before,
    account: options.account,
  });
}

/** Per-address total/unread counts across the supplied domains. */
export async function inboxCountsForDomains(
  env: Env,
  domains: string[],
): Promise<{
  counts: Record<string, { total: number; unread: number }>;
  totalAll: number;
  unreadAll: number;
}> {
  const mailDb = createMailDb(env.RELAYBASE_MAIL);
  const counts: Record<string, { total: number; unread: number }> = {};
  let totalAll = 0;
  let unreadAll = 0;
  for (const domain of domains) {
    const normalized = domain.trim().toLowerCase();
    if (!normalized || !mailDb) continue;
    const byAddress = await mailboxAddressCounts(mailDb, "inbound", normalized);
    for (const [address, c] of Object.entries(byAddress)) {
      const bucket = counts[address] ?? { total: 0, unread: 0 };
      bucket.total += c.total;
      bucket.unread += c.unread;
      counts[address] = bucket;
      totalAll += c.total;
      unreadAll += c.unread;
    }
  }
  return { counts, totalAll, unreadAll };
}

export async function getInboxMessage(
  env: Env,
  id: string,
  domainHint?: string,
): Promise<InboxMessage | null> {
  const domain = domainHint?.trim().toLowerCase();
  if (domain) {
    const message = await getMailMessage(env.INBOUND, "inbound", domain, id);
    if (message) return serializeInboundMessage(message);
  }
  // No global scan — callers must pass a domain hint. Return null when absent.
  return null;
}

/**
 * Look up a message within a set of domains only (mobile scope). Tries each
 * domain in order and returns the first hit so a request scoped to
 * mobile-enabled domains can never leak a message from a disabled domain.
 */
export async function getInboxMessageForDomains(
  env: Env,
  domains: string[],
  id: string,
): Promise<InboxMessage | null> {
  for (const domain of domains) {
    const normalized = domain.trim().toLowerCase();
    if (!normalized) continue;
    const message = await getMailMessage(env.INBOUND, "inbound", normalized, id);
    if (message) return serializeInboundMessage(message);
  }
  return null;
}

export async function getInboxAttachmentResult(
  env: Env,
  params: { domain: string; messageId: string; attachmentId: string },
) {
  return getInboundAttachment(env.INBOUND, params);
}

/**
 * Bulk mark read/unread for ids that may span multiple domains. Resolves
 * each id's domain by trying each supplied domain, then applies
 * `setMailReadState` per domain.
 */
export async function setInboxReadStateMultiDomain(
  env: Env,
  domains: string[],
  ids: string[],
  read: boolean,
): Promise<{ updated: string[] }> {
  const readAt = read ? new Date().toISOString() : null;
  const mailDb = createMailDb(env.RELAYBASE_MAIL);
  const updated: string[] = [];
  const idSet = new Set(ids.map((id) => id.trim()).filter(Boolean));
  if (idSet.size === 0) return { updated };

  for (const domain of domains) {
    const normalized = domain.trim().toLowerCase();
    if (!normalized) continue;
    if (idSet.size === 0) break;
    // Try each pending id against this domain's thin meta.
    const resolved: string[] = [];
    for (const id of idSet) {
      const message = await getMailMessage(env.INBOUND, "inbound", normalized, id);
      if (message) resolved.push(id);
    }
    if (!resolved.length) continue;
    const result = await setMailReadState(
      env.INBOUND,
      normalized,
      resolved,
      readAt,
      mailDb,
    );
    for (const id of result.updated) {
      updated.push(id);
      idSet.delete(id);
    }
  }
  return { updated };
}

/** Pending inbound events across the supplied domains (mobile poll surface). */
export async function listInboxNotificationsForDomains(
  env: Env,
  domains: string[],
  limit = 25,
): Promise<InboundEmailEvent[]> {
  const collected: InboundEmailEvent[] = [];
  for (const domain of domains) {
    const normalized = domain.trim().toLowerCase();
    if (!normalized) continue;
    const events = await listPendingEvents(createAppDb(env.RELAYBASE_DB), normalized, 100);
    collected.push(...events);
  }
  collected.sort((a, b) => b.data.receivedAt.localeCompare(a.data.receivedAt));
  return collected.slice(0, Math.min(Math.max(limit, 1), 100));
}

/** Ack pending events for a single domain (mobile ack). */
export async function ackInboxNotifications(
  env: Env,
  domain: string,
  ids: string[],
): Promise<number> {
  return ackPendingEvents(createAppDb(env.RELAYBASE_DB), domain, ids);
}
