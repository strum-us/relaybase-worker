/**
 * Unified mailbox store: one R2 layout + one D1 index for inbound AND sent.
 *
 * R2 layout (binding `INBOUND`, bucket `relaybase-mailbox`):
 *   inbound/{domain}/{uuid}/meta.json | raw.eml | attachments/…
 *   inbound/{domain}/by-message-id/{encoded}        # single-key pointer
 *   sent/{domain}/{uuid}/meta.json | raw.eml | attachments/…
 *   sent/{domain}/by-message-id/{encoded}
 *   sent/_sendlog/{uuid}.json                       # no _index.json
 *
 * `meta.json` is THIN: headers + `bodyPreview` (≤500 chars) + attachment list
 * + `readAt`/`sentAt` + `hasText`/`hasHtml`. It NEVER contains `bodyText` or
 * `bodyHtml` — those are parsed on demand from `raw.eml` via `parseInboundMime`.
 *
 * D1 `relaybase-mail` (`mailbox_messages` + `mailbox_fts`) is the list/count/
 * search index. R2 stays the source of truth; D1 is rebuildable via
 * `POST /console/rebuild-mail`. D1 writes are best-effort and must never
 * fail the ingest path.
 */
import {
  buildBouncePreview,
  isBounceMessage,
  parseBounceDiagnostic,
} from "./bounce-detect";
import { normalizeAttachmentBytes } from "./attachment-bytes.ts";
import { decodeMimeHeader, parseInboundMime } from "./mime-parse";
import { buildMimeMessage, buildStrippedInboundMime } from "./mime";
import type { MailDb } from "../../db/mail";
import {
  deleteMailboxFts,
  upsertMailboxFts,
} from "../../db/mail/search";
import {
  deleteMailboxMessages,
  mailboxIdsForDomain,
  mailboxPruneIds,
  updateMailboxReadState,
  upsertMailboxMessage,
  recipientsColumn,
} from "../../db/mail/messages";
import type { MailboxKind, MailboxMessageRow } from "../../db/mail/schema";

export type InboundAttachmentMeta = {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  disposition: string;
  contentId: string | null;
};

export type InboundEmailMeta = {
  id: string;
  domain: string;
  fromEmail: string;
  fromName?: string;
  toEmail: string;
  toEmails?: string[];
  ccEmails?: string[];
  subject: string;
  receivedAt: string;
  messageId: string | null;
  inReplyTo: string | null;
  references: string | null;
  size: number;
  bodyPreview: string;
  bodyText: string;
  bodyHtml: string | null;
  attachments: InboundAttachmentMeta[];
  readAt?: string | null;
};

/** Thin `meta.json` shape — no `bodyText` / `bodyHtml`. */
export type ThinMailMeta = {
  id: string;
  kind: MailboxKind;
  domain: string;
  fromEmail: string;
  fromName?: string;
  toEmail: string;
  toEmails?: string[];
  ccEmails?: string[];
  subject: string;
  /** Inbound `receivedAt` or sent `sentAt` (ISO). */
  occurredAt: string;
  messageId: string | null;
  inReplyTo: string | null;
  references: string | null;
  size: number;
  bodyPreview: string;
  attachments: InboundAttachmentMeta[];
  /** Inbound only — null/missing on sent rows. */
  readAt?: string | null;
  /** True when `raw.eml` carries a text/html part. False for legacy sent rows
   * imported from `_list.json` that only had `bodyPreview`. */
  hasText?: boolean;
  hasHtml?: boolean;
};

/** Max R2 prefixes deleted per pruneMail call (cron batch). */
export const PRUNE_BATCH_LIMIT = 50;
const INBOUND_PREFIX = "inbound";
const SENT_PREFIX = "sent";

const JSON_META = { httpMetadata: { contentType: "application/json" } };
const EML_META = { httpMetadata: { contentType: "message/rfc822" } };

function domainFromAddress(address: string): string {
  const at = address.lastIndexOf("@");
  return at >= 0 ? address.slice(at + 1).trim().toLowerCase() : "";
}

function prefixFor(kind: MailboxKind): string {
  return kind === "sent" ? SENT_PREFIX : INBOUND_PREFIX;
}

function objectPrefix(kind: MailboxKind, domain: string, id: string): string {
  return `${prefixFor(kind)}/${domain}/${id}`;
}

function metaObjectKey(kind: MailboxKind, domain: string, id: string): string {
  return `${objectPrefix(kind, domain, id)}/meta.json`;
}

function rawObjectKey(kind: MailboxKind, domain: string, id: string): string {
  return `${objectPrefix(kind, domain, id)}/raw.eml`;
}

function attachmentObjectKey(
  kind: MailboxKind,
  domain: string,
  id: string,
  attachmentId: string,
  filename: string,
): string {
  const safeName = filename.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120);
  return `${objectPrefix(kind, domain, id)}/attachments/${attachmentId}-${safeName}`;
}

function messageIdIndexKey(
  kind: MailboxKind,
  domain: string,
  normalizedMessageId: string,
): string {
  return `${prefixFor(kind)}/${domain}/by-message-id/${encodeURIComponent(normalizedMessageId)}`;
}

/** Normalize RFC Message-ID for comparison (`<id@host>` → `id@host`). */
export function normalizeInboundMessageId(
  raw: string | null | undefined,
): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return null;
  const unwrapped =
    trimmed.startsWith("<") && trimmed.endsWith(">")
      ? trimmed.slice(1, -1).trim()
      : trimmed;
  return unwrapped || null;
}

export function previewText(text: string, max = 500): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 1)}…`;
}

function joinAddressList(value: string[] | undefined): string {
  return (value ?? []).map((entry) => entry.trim()).filter(Boolean).join(",");
}

function splitAddressList(value: string | null): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizeThinMeta(meta: ThinMailMeta): ThinMailMeta {
  return {
    ...meta,
    attachments: meta.attachments ?? [],
    toEmails:
      meta.toEmails && meta.toEmails.length > 0
        ? meta.toEmails
        : meta.toEmail
          ? [meta.toEmail]
          : [],
    ccEmails: meta.ccEmails ?? [],
    readAt: meta.kind === "sent" ? null : (meta.readAt ?? null),
  };
}

function thinMetaToRow(meta: ThinMailMeta): MailboxMessageRow {
  return {
    id: meta.id,
    kind: meta.kind,
    domain: meta.domain,
    from_email: meta.fromEmail,
    from_name: meta.fromName ?? null,
    to_email: meta.toEmail,
    to_emails: joinAddressList(meta.toEmails),
    cc_emails: joinAddressList(meta.ccEmails),
    recipients: recipientsColumn({
      toEmail: meta.toEmail,
      toEmails: meta.toEmails,
      ccEmails: meta.ccEmails,
    }),
    subject: meta.subject,
    body_preview: meta.bodyPreview,
    occurred_at: meta.occurredAt,
    message_id: meta.messageId,
    in_reply_to: meta.inReplyTo,
    refs: meta.references,
    size: meta.size,
    attachment_count: meta.attachments?.length ?? 0,
    read_at: meta.readAt ?? null,
    r2_prefix: objectPrefix(meta.kind, meta.domain, meta.id),
  };
}

function rowToInboundMeta(
  row: Pick<
    MailboxMessageRow,
    | "id"
    | "domain"
    | "from_email"
    | "from_name"
    | "to_email"
    | "to_emails"
    | "cc_emails"
    | "subject"
    | "occurred_at"
    | "message_id"
    | "in_reply_to"
    | "refs"
    | "size"
    | "attachment_count"
    | "read_at"
  >,
  bodyPreview: string,
): InboundEmailMeta {
  return {
    id: row.id,
    domain: row.domain,
    fromEmail: row.from_email,
    fromName: row.from_name ?? undefined,
    toEmail: row.to_email,
    toEmails: splitAddressList(row.to_emails),
    ccEmails: splitAddressList(row.cc_emails),
    subject: row.subject,
    receivedAt: row.occurred_at,
    messageId: row.message_id,
    inReplyTo: row.in_reply_to,
    references: row.refs,
    size: row.size,
    bodyPreview,
    bodyText: "",
    bodyHtml: null,
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

function thinMetaToInboundMeta(
  meta: ThinMailMeta,
  bodyText: string,
): InboundEmailMeta {
  return {
    id: meta.id,
    domain: meta.domain,
    fromEmail: meta.fromEmail,
    fromName: meta.fromName,
    toEmail: meta.toEmail,
    toEmails: meta.toEmails,
    ccEmails: meta.ccEmails,
    subject: meta.subject,
    receivedAt: meta.occurredAt,
    messageId: meta.messageId,
    inReplyTo: meta.inReplyTo,
    references: meta.references,
    size: meta.size,
    bodyPreview: meta.bodyPreview,
    bodyText,
    bodyHtml: null,
    attachments: meta.attachments ?? [],
    readAt: meta.readAt ?? null,
  };
}

async function writeMessageIdIndex(
  bucket: R2Bucket,
  kind: MailboxKind,
  domain: string,
  normalizedMessageId: string,
  id: string,
): Promise<void> {
  await bucket.put(
    messageIdIndexKey(kind, domain, normalizedMessageId),
    id,
    { httpMetadata: { contentType: "text/plain" } },
  );
}

async function readMessageIdIndex(
  bucket: R2Bucket,
  kind: MailboxKind,
  domain: string,
  normalizedMessageId: string,
): Promise<string | null> {
  const object = await bucket.get(
    messageIdIndexKey(kind, domain, normalizedMessageId),
  );
  if (!object) return null;
  const id = (await object.text()).trim();
  return id || null;
}

export async function loadThinMeta(
  bucket: R2Bucket,
  kind: MailboxKind,
  domain: string,
  id: string,
): Promise<ThinMailMeta | null> {
  const object = await bucket.get(metaObjectKey(kind, domain, id));
  if (!object) return null;
  try {
    const meta = JSON.parse(await object.text()) as ThinMailMeta;
    return normalizeThinMeta(meta);
  } catch {
    return null;
  }
}

async function deleteMessageObjects(
  bucket: R2Bucket,
  kind: MailboxKind,
  domain: string,
  id: string,
): Promise<void> {
  const prefix = `${objectPrefix(kind, domain, id)}/`;
  let cursor: string | undefined;
  do {
    const listed = await bucket.list({ prefix, cursor });
    for (const object of listed.objects) {
      await bucket.delete(object.key);
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
}

async function indexMessage(
  mailDb: MailDb,
  meta: ThinMailMeta,
  bodyText: string,
): Promise<void> {
  if (!mailDb) return;
  await upsertMailboxMessage(mailDb, thinMetaToRow(meta));
  await upsertMailboxFts(mailDb, [
    {
      id: meta.id,
      kind: meta.kind,
      domain: meta.domain,
      subject: meta.subject,
      from_email: meta.fromEmail,
      from_name: meta.fromName ?? null,
      to_emails: joinAddressList(meta.toEmails),
      cc_emails: joinAddressList(meta.ccEmails),
      body_text: bodyText,
    },
  ]);
}

export type StoreInboundMailResult = {
  record: InboundEmailMeta;
  created: boolean;
};

/**
 * Store one inbound email. Dedupes by RFC Message-ID via the R2
 * `by-message-id/{id}` pointer ONLY — never scans `meta.json` folders (the
 * full-domain scan that used to OOM large mailboxes like `wedesk.so`).
 */
export async function storeInboundMail(
  bucket: R2Bucket,
  params: {
    envelopeFrom: string;
    toEmail: string;
    subject: string;
    messageId: string | null;
    inReplyTo?: string | null;
    references?: string | null;
    size: number;
    raw: ArrayBuffer;
  },
  mailDb: MailDb,
): Promise<StoreInboundMailResult> {
  const receivedAt = new Date().toISOString();
  const domain = domainFromAddress(params.toEmail);
  if (!domain) {
    throw new Error("Inbound email is missing a recipient domain");
  }

  const normalizedMessageId = normalizeInboundMessageId(params.messageId);
  if (normalizedMessageId) {
    const existingId = await readMessageIdIndex(
      bucket,
      "inbound",
      domain,
      normalizedMessageId,
    );
    if (existingId) {
      const existing = await loadThinMeta(bucket, "inbound", domain, existingId);
      if (existing) {
        return {
          record: thinMetaToInboundMeta(existing, ""),
          created: false,
        };
      }
    }
  }

  const id = crypto.randomUUID();
  const parsed = await parseInboundMime(params.raw);
  const attachmentMeta: InboundAttachmentMeta[] = [];

  for (const attachment of parsed.attachments) {
    await bucket.put(
      attachmentObjectKey("inbound", domain, id, attachment.id, attachment.filename),
      attachment.content,
      {
        httpMetadata: { contentType: attachment.contentType },
        customMetadata: {
          filename: attachment.filename,
          disposition: attachment.disposition,
        },
      },
    );
    attachmentMeta.push({
      id: attachment.id,
      filename: attachment.filename,
      contentType: attachment.contentType,
      size: attachment.size,
      disposition: attachment.disposition,
      contentId: attachment.contentId,
    });
  }

  const subject =
    parsed.subject || decodeMimeHeader(params.subject) || "(no subject)";

  const isBounce = isBounceMessage(params.raw, params.envelopeFrom);
  const bounceDiagnostic = isBounce ? parseBounceDiagnostic(params.raw) : null;
  const bouncePreview = bounceDiagnostic
    ? buildBouncePreview(bounceDiagnostic)
    : null;

  const bodyText =
    parsed.bodyText || (isBounce ? bouncePreview ?? "(empty message)" : "");
  const bodyPreview = previewText(
    bodyText || params.subject || (isBounce ? "Bounce notification" : ""),
  );

  const toEmails = parsed.toEmails.length ? parsed.toEmails : [params.toEmail];
  const fromEmail = parsed.fromEmail || params.envelopeFrom;
  const fromName = parsed.fromName;

  const thin: ThinMailMeta = {
    id,
    kind: "inbound",
    domain,
    fromEmail,
    fromName,
    toEmail: params.toEmail,
    toEmails,
    ccEmails: parsed.ccEmails,
    subject,
    occurredAt: receivedAt,
    messageId: params.messageId,
    inReplyTo: params.inReplyTo ?? null,
    references: params.references ?? null,
    size: params.size,
    bodyPreview,
    attachments: attachmentMeta,
    readAt: null,
    hasText: Boolean(parsed.bodyText),
    hasHtml: Boolean(parsed.bodyHtml),
  };

  await bucket.put(
    metaObjectKey("inbound", domain, id),
    JSON.stringify(thin),
    JSON_META,
  );

  const rawBody =
    attachmentMeta.length > 0
      ? buildStrippedInboundMime({
          fromEmail,
          fromName,
          toEmail: params.toEmail,
          ccEmails: parsed.ccEmails,
          subject,
          messageId: params.messageId,
          bodyText: parsed.bodyText,
          bodyHtml: parsed.bodyHtml,
          attachments: attachmentMeta,
        })
      : params.raw;

  await bucket.put(rawObjectKey("inbound", domain, id), rawBody, {
    ...EML_META,
    customMetadata: {
      from: params.envelopeFrom,
      to: params.toEmail,
      domain,
    },
  });

  if (normalizedMessageId) {
    await writeMessageIdIndex(bucket, "inbound", domain, normalizedMessageId, id);
  }

  try {
    await indexMessage(mailDb, thin, bodyText);
  } catch (error) {
    console.error("Failed to index inbound email", error);
  }

  return {
    record: thinMetaToInboundMeta(thin, bodyText),
    created: true,
  };
}

export type StoreSentMailParams = {
  from: string;
  fromName?: string;
  to: string[];
  cc?: string[];
  subject: string;
  text: string;
  html?: string;
  messageId: string | null;
  inReplyTo?: string | null;
  references?: string | null;
  /** Pre-built MIME body to persist as `raw.eml`. When omitted, the MIME is
   * built from the params via `buildMimeMessage`. */
  rawMime?: string;
  sentAt?: string;
  attachments?: Array<{
    filename: string;
    contentType: string;
    content: ArrayBuffer;
    size: number;
  }>;
};

export type StoreSentMailResult = {
  record: ThinMailMeta;
  created: boolean;
};

/**
 * Persist one sent email under `sent/{domain}/{uuid}/` (thin meta + raw.eml
 * + pointer) and upsert D1 `kind=sent`. Same shape as inbound. Returns the
 * stored row id (the RFC Message-ID when present, else a fresh UUID).
 */
export async function storeSentMail(
  bucket: R2Bucket,
  params: StoreSentMailParams,
  mailDb: MailDb,
): Promise<StoreSentMailResult> {
  const domain = domainFromAddress(params.from);
  if (!domain) {
    throw new Error("Sent email is missing a sender domain");
  }

  const sentAt = params.sentAt ?? new Date().toISOString();
  const id = params.messageId?.trim() || crypto.randomUUID();
  const normalizedMessageId = normalizeInboundMessageId(params.messageId);

  // Dedupe by RFC Message-ID pointer only.
  if (normalizedMessageId) {
    const existingId = await readMessageIdIndex(
      bucket,
      "sent",
      domain,
      normalizedMessageId,
    );
    if (existingId && existingId !== id) {
      const existing = await loadThinMeta(bucket, "sent", domain, existingId);
      if (existing) {
        return { record: existing, created: false };
      }
    }
  }

  const rawMime =
    params.rawMime ??
    buildSentMime({
      from: params.from,
      fromName: params.fromName,
      to: params.to,
      cc: params.cc,
      subject: params.subject,
      text: params.text,
      html: params.html,
      messageId: params.messageId,
      inReplyTo: params.inReplyTo,
      references: params.references,
      attachments: params.attachments?.map((item) => ({
        filename: item.filename,
        contentType: item.contentType,
        content: item.content,
      })),
    });

  const attachmentMeta: InboundAttachmentMeta[] = [];
  for (let index = 0; index < (params.attachments?.length ?? 0); index++) {
    const attachment = params.attachments![index]!;
    const attachmentId = String(index);
    await bucket.put(
      attachmentObjectKey("sent", domain, id, attachmentId, attachment.filename),
      attachment.content,
      {
        httpMetadata: { contentType: attachment.contentType },
        customMetadata: {
          filename: attachment.filename,
          disposition: "attachment",
        },
      },
    );
    attachmentMeta.push({
      id: attachmentId,
      filename: attachment.filename,
      contentType: attachment.contentType,
      size: attachment.size,
      disposition: "attachment",
      contentId: null,
    });
  }

  const rawBody =
    attachmentMeta.length > 0
      ? buildStrippedInboundMime({
          fromEmail: params.from,
          fromName: params.fromName,
          toEmail: params.to[0] ?? params.from,
          ccEmails: params.cc ?? [],
          subject: params.subject,
          messageId: params.messageId,
          bodyText: params.text,
          bodyHtml: params.html ?? null,
          attachments: attachmentMeta,
        })
      : new TextEncoder().encode(rawMime).buffer;

  const thin: ThinMailMeta = {
    id,
    kind: "sent",
    domain,
    fromEmail: params.from,
    fromName: params.fromName,
    toEmail: params.to[0] ?? params.from,
    toEmails: params.to,
    ccEmails: params.cc ?? [],
    subject: params.subject,
    occurredAt: sentAt,
    messageId: params.messageId,
    inReplyTo: params.inReplyTo ?? null,
    references: params.references ?? null,
    size: rawBody.byteLength,
    bodyPreview: previewText(params.text),
    attachments: attachmentMeta,
    readAt: null,
    hasText: Boolean(params.text),
    hasHtml: Boolean(params.html?.trim()),
  };

  await bucket.put(
    metaObjectKey("sent", domain, id),
    JSON.stringify(thin),
    JSON_META,
  );
  await bucket.put(rawObjectKey("sent", domain, id), rawBody, {
    ...EML_META,
    customMetadata: {
      from: params.from,
      to: params.to.join(", "),
      domain,
    },
  });

  if (normalizedMessageId) {
    await writeMessageIdIndex(bucket, "sent", domain, normalizedMessageId, id);
  }

  try {
    await indexMessage(mailDb, thin, params.text);
  } catch (error) {
    console.error("Failed to index sent email", error);
  }

  return { record: thin, created: true };
}

function buildSentMime(
  params: StoreSentMailParams & {
    attachments?: Array<{
      filename: string;
      contentType: string;
      content: ArrayBuffer;
    }>;
  },
): string {
  return buildMimeMessage({
    from: params.from,
    fromName: params.fromName,
    to: params.to.length === 1 ? params.to[0] : params.to,
    cc: params.cc,
    subject: params.subject,
    text: params.text,
    html: params.html,
    messageId: params.messageId ?? undefined,
    inReplyTo: params.inReplyTo ?? undefined,
    references: params.references ?? undefined,
    attachments: params.attachments,
  });
}

/**
 * Fetch one message as a full `InboundEmailMeta` (body parsed on demand from
 * `raw.eml`). Returns null when `meta.json` is missing. `hasText`/`hasHtml`
 * are hints only — always try `raw.eml` when the object exists (rebuild used
 * to write those flags as false after stripping fat `bodyText`/`bodyHtml`).
 * Legacy sent rows with no `raw.eml` fall back to `bodyPreview`.
 */
export async function getMailMessage(
  bucket: R2Bucket,
  kind: MailboxKind,
  domain: string,
  id: string,
): Promise<InboundEmailMeta | null> {
  const normalizedDomain = domain.trim().toLowerCase();
  const thin = await loadThinMeta(bucket, kind, normalizedDomain, id);
  if (!thin) return null;

  let bodyText = "";
  let bodyHtml: string | null = null;
  const rawObject = await bucket.get(
    rawObjectKey(kind, normalizedDomain, id),
  );
  if (rawObject) {
    try {
      const parsed = await parseInboundMime(await rawObject.arrayBuffer());
      bodyText = parsed.bodyText;
      bodyHtml = parsed.bodyHtml;
    } catch (error) {
      console.error("Failed to parse raw.eml for detail", error);
    }
  }

  const meta: InboundEmailMeta = thinMetaToInboundMeta(
    thin,
    bodyText || (rawObject ? "" : thin.bodyPreview),
  );
  meta.bodyHtml = bodyHtml;
  return meta;
}

export async function getMailAttachment(
  bucket: R2Bucket,
  kind: MailboxKind,
  params: { domain: string; messageId: string; attachmentId: string },
): Promise<{ meta: InboundAttachmentMeta; body: ArrayBuffer } | null> {
  const domain = params.domain.trim().toLowerCase();
  const thin = await loadThinMeta(bucket, kind, domain, params.messageId);
  if (!thin) return null;
  const attachment = thin.attachments.find(
    (item) => item.id === params.attachmentId,
  );
  if (!attachment) return null;
  const prefix = `${objectPrefix(kind, domain, params.messageId)}/attachments/${attachment.id}-`;
  const listed = await bucket.list({ prefix, limit: 20 });
  const objectKey = listed.objects[0]?.key;
  if (!objectKey) return null;
  const object = await bucket.get(objectKey);
  if (!object) return null;
  const rawBody = await object.arrayBuffer();
  return {
    meta: attachment,
    body: normalizeAttachmentBytes(rawBody),
  };
}

/** @deprecated Use getMailAttachment with kind `"inbound"`. */
export async function getInboundAttachment(
  bucket: R2Bucket,
  params: { domain: string; messageId: string; attachmentId: string },
): Promise<{ meta: InboundAttachmentMeta; body: ArrayBuffer } | null> {
  return getMailAttachment(bucket, "inbound", params);
}

/**
 * Bulk mark-read/unread for inbound messages. Updates thin `meta.json` and
 * D1. Sent rows are skipped (sent has no read state). Ids that don't resolve
 * to a message in this domain are skipped.
 */
export async function setMailReadState(
  bucket: R2Bucket,
  domain: string,
  ids: string[],
  readAt: string | null,
  mailDb: MailDb,
): Promise<{ updated: string[] }> {
  const normalizedDomain = domain.trim().toLowerCase();
  const uniqueIds = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
  const updated: string[] = [];

  await Promise.all(
    uniqueIds.map(async (id) => {
      const thin = await loadThinMeta(bucket, "inbound", normalizedDomain, id);
      if (!thin) return;
      const next: ThinMailMeta = { ...thin, readAt };
      await bucket.put(
        metaObjectKey("inbound", normalizedDomain, id),
        JSON.stringify(next),
        JSON_META,
      );
      updated.push(id);
    }),
  );

  if (updated.length > 0 && mailDb) {
    try {
      await updateMailboxReadState(mailDb, updated, readAt);
    } catch (error) {
      console.error("Failed to sync read state to mail index", error);
    }
  }
  return { updated };
}

/**
 * Delete messages beyond `keep` per (kind, domain). Uses D1 to find ids,
 * then deletes their R2 prefixes and D1 rows. `keep <= 0` is a no-op
 * (unlimited). `limit` caps how many prefixes this isolate deletes.
 */
export async function pruneMail(
  bucket: R2Bucket,
  mailDb: MailDb,
  kind: MailboxKind,
  domain: string,
  keep: number,
  limit = PRUNE_BATCH_LIMIT,
): Promise<number> {
  if (!mailDb || keep <= 0) return 0;
  const normalizedDomain = domain.trim().toLowerCase();
  let staleIds: string[] = [];
  try {
    staleIds = await mailboxPruneIds(
      mailDb,
      kind,
      normalizedDomain,
      keep,
      limit,
    );
  } catch (error) {
    console.error("Failed to compute prune ids", error);
    return 0;
  }
  if (staleIds.length === 0) return 0;
  for (const id of staleIds) {
    await deleteMessageObjects(bucket, kind, normalizedDomain, id);
  }
  try {
    await deleteMailboxMessages(mailDb, staleIds);
    await deleteMailboxFts(mailDb, staleIds);
  } catch (error) {
    console.error("Failed to prune mail index rows", error);
  }
  return staleIds.length;
}

/** Per-message `{id}/` folder ids under a domain (skips `by-message-id/`). */
export async function listMessageFolderIds(
  bucket: R2Bucket,
  kind: MailboxKind,
  domain: string,
): Promise<string[]> {
  const prefix = `${prefixFor(kind)}/${domain.trim().toLowerCase()}/`;
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const listed = await bucket.list({ prefix, delimiter: "/", cursor });
    for (const folder of listed.delimitedPrefixes ?? []) {
      if (!folder.startsWith(prefix)) continue;
      const id = folder.slice(prefix.length).replace(/\/$/, "");
      if (!id || id.includes("/") || id === "by-message-id") continue;
      ids.push(id);
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  return ids;
}

// ──────────────────────────────────────────────────────────────────────────
// Rebuild helpers (POST /console/rebuild-mail). These read legacy fat metas /
// array indexes once, write thin metas + D1 rows, and delete array keys. They
// are NOT on the ingest path.
// ──────────────────────────────────────────────────────────────────────────

/** Read whatever JSON lives at a key (legacy array or fat meta). */
async function readJsonAt<T>(bucket: R2Bucket, key: string): Promise<T | null> {
  const object = await bucket.get(key);
  if (!object) return null;
  try {
    return JSON.parse(await object.text()) as T;
  } catch {
    return null;
  }
}

/** Best-effort: parse `raw.eml` body text for FTS. Never throws. */
async function readEmlBodyText(
  bucket: R2Bucket,
  kind: MailboxKind,
  domain: string,
  id: string,
): Promise<string> {
  try {
    const object = await bucket.get(rawObjectKey(kind, domain, id));
    if (!object) return "";
    const parsed = await parseInboundMime(await object.arrayBuffer());
    return parsed.bodyText;
  } catch {
    return "";
  }
}

/** Coerce a legacy fat meta (with bodyText/bodyHtml) into a thin meta. */
type LegacyMeta = {
  fromEmail?: string;
  fromName?: string;
  toEmail?: string;
  toEmails?: string[];
  ccEmails?: string[];
  subject?: string;
  occurredAt?: string;
  receivedAt?: string;
  sentAt?: string;
  messageId?: string | null;
  inReplyTo?: string | null;
  references?: string | null;
  size?: number;
  bodyPreview?: string;
  bodyText?: string;
  bodyHtml?: string | null;
  attachments?: InboundAttachmentMeta[];
  readAt?: string | null;
  hasText?: boolean;
  hasHtml?: boolean;
};

function stripFatMeta(meta: Record<string, unknown>): LegacyMeta {
  const next: Record<string, unknown> = { ...meta };
  delete next.bodyText;
  delete next.bodyHtml;
  return next as unknown as LegacyMeta;
}

export type RebuildDomainResult = {
  domain: string;
  inbound: number;
  sent: number;
  deletedKeys: string[];
};

/**
 * Rebuild one domain: thin every inbound meta, materialize sent folders from
 * legacy `_list.json`/`_sent.json`, upsert D1 rows + FTS, delete array keys.
 * Chunked via `waitUntil` by the caller — this function processes one domain
 * end-to-end and returns counts.
 */
export async function rebuildDomain(
  bucket: R2Bucket,
  mailDb: MailDb,
  domain: string,
): Promise<RebuildDomainResult> {
  const normalized = domain.trim().toLowerCase();
  const deletedKeys: string[] = [];
  let inboundCount = 0;
  let sentCount = 0;

  // 1. Inbound: list uuid folders, thin fat metas, upsert D1.
  // Skip ids already in D1 so a timed-out rebuild can resume.
  const inboundDone = await mailboxIdsForDomain(mailDb, "inbound", normalized);
  const inboundIds = await listMessageFolderIds(bucket, "inbound", normalized);
  for (const id of inboundIds) {
    if (inboundDone.has(id)) {
      inboundCount += 1;
      continue;
    }
    const metaKey = metaObjectKey("inbound", normalized, id);
    const raw = await readJsonAt<Record<string, unknown>>(bucket, metaKey);
    if (!raw) continue;
    const fatHasText = Boolean(raw.hasText ?? raw.bodyText);
    const fatHasHtml = Boolean(raw.hasHtml ?? raw.bodyHtml);
    const stripped = stripFatMeta(raw);
    const emlExists = Boolean(
      await bucket.head(rawObjectKey("inbound", normalized, id)),
    );
    const thin = normalizeThinMeta({
      id,
      kind: "inbound",
      domain: normalized,
      fromEmail: stripped.fromEmail ?? "",
      fromName: stripped.fromName,
      toEmail: stripped.toEmail ?? "",
      toEmails: stripped.toEmails,
      ccEmails: stripped.ccEmails,
      subject: stripped.subject ?? "",
      occurredAt: stripped.occurredAt ?? stripped.receivedAt ?? new Date().toISOString(),
      messageId: stripped.messageId ?? null,
      inReplyTo: stripped.inReplyTo ?? null,
      references: stripped.references ?? null,
      size: stripped.size ?? 0,
      bodyPreview: previewText(stripped.bodyPreview ?? ""),
      attachments: stripped.attachments ?? [],
      readAt: stripped.readAt ?? null,
      hasText: fatHasText || emlExists,
      hasHtml: fatHasHtml || emlExists,
    });
    await bucket.put(metaKey, JSON.stringify(thin), JSON_META);
    const bodyText = await readEmlBodyText(bucket, "inbound", normalized, id);
    try {
      await indexMessage(mailDb, thin, bodyText);
    } catch (error) {
      console.error(`rebuild inbound index failed ${normalized}/${id}`, error);
    }
    inboundCount += 1;
  }

  // 2. Sent: prefer existing sent uuid folders; otherwise materialize from
  //    legacy _list.json / _sent.json arrays (no raw.eml — preview only).
  const sentDone = await mailboxIdsForDomain(mailDb, "sent", normalized);
  const sentIds = await listMessageFolderIds(bucket, "sent", normalized);
  for (const id of sentIds) {
    if (sentDone.has(id)) {
      sentCount += 1;
      continue;
    }
    const metaKey = metaObjectKey("sent", normalized, id);
    const raw = await readJsonAt<Record<string, unknown>>(bucket, metaKey);
    if (!raw) continue;
    const stripped = stripFatMeta(raw);
    const emlExists = Boolean(
      await bucket.head(rawObjectKey("sent", normalized, id)),
    );
    const thin = normalizeThinMeta({
      id,
      kind: "sent",
      domain: normalized,
      fromEmail: stripped.fromEmail ?? "",
      fromName: stripped.fromName,
      toEmail: stripped.toEmail ?? "",
      toEmails: stripped.toEmails,
      ccEmails: stripped.ccEmails,
      subject: stripped.subject ?? "",
      occurredAt: stripped.occurredAt ?? stripped.sentAt ?? new Date().toISOString(),
      messageId: stripped.messageId ?? null,
      inReplyTo: stripped.inReplyTo ?? null,
      references: stripped.references ?? null,
      size: stripped.size ?? 0,
      bodyPreview: previewText(stripped.bodyPreview ?? ""),
      attachments: stripped.attachments ?? [],
      hasText: Boolean(stripped.hasText) || emlExists,
      hasHtml: Boolean(stripped.hasHtml) || emlExists,
    });
    await bucket.put(metaKey, JSON.stringify(thin), JSON_META);
    const bodyText = await readEmlBodyText(bucket, "sent", normalized, id);
    try {
      await indexMessage(mailDb, thin, bodyText);
    } catch (error) {
      console.error(`rebuild sent index failed ${normalized}/${id}`, error);
    }
    sentCount += 1;
  }

  // Materialize sent from legacy arrays when no sent folders exist yet.
  if (sentIds.length === 0) {
    const legacy = await readJsonAt<unknown[]>(
      bucket,
      `sent/${normalized}/_list.json`,
    );
    const legacySent = legacy ?? await readJsonAt<unknown[]>(
      bucket,
      `inbound/${normalized}/_sent.json`,
    );
    if (legacySent && Array.isArray(legacySent)) {
      for (const entry of legacySent) {
        const row = entry as Record<string, unknown>;
        const id = String(row.id ?? row.messageId ?? crypto.randomUUID());
        const fromEmail = String(row.from ?? "");
        const toEmails = Array.isArray(row.to)
          ? (row.to as string[])
          : String(row.to ?? "")
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean);
        const ccEmails = Array.isArray(row.cc)
          ? (row.cc as string[])
          : String(row.cc ?? "")
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean);
        const thin: ThinMailMeta = normalizeThinMeta({
          id,
          kind: "sent",
          domain: normalized,
          fromEmail,
          fromName: row.fromName ? String(row.fromName) : undefined,
          toEmail: toEmails[0] ?? fromEmail,
          toEmails: toEmails,
          ccEmails: ccEmails,
          subject: String(row.subject ?? ""),
          occurredAt: String(row.sentAt ?? new Date().toISOString()),
          messageId: row.messageId ? String(row.messageId) : null,
          inReplyTo: row.inReplyTo ? String(row.inReplyTo) : null,
          references: row.references ? String(row.references) : null,
          size: Number(row.size ?? 0),
          bodyPreview: previewText(String(row.bodyPreview ?? "")),
          attachments: [],
          hasText: false,
          hasHtml: false,
        });
        await bucket.put(
          metaObjectKey("sent", normalized, id),
          JSON.stringify(thin),
          JSON_META,
        );
        try {
          await indexMessage(mailDb, thin, thin.bodyPreview);
        } catch (error) {
          console.error(`rebuild sent legacy index failed ${normalized}/${id}`, error);
        }
        sentCount += 1;
      }
    }
  }

  // 3. Delete array keys (legacy indexes).
  const arrayKeys = [
    `inbound/${normalized}/_list.json`,
    `sent/${normalized}/_list.json`,
    `inbound/${normalized}/_sent.json`,
  ];
  for (const key of arrayKeys) {
    const object = await bucket.head(key);
    if (object) {
      await bucket.delete(key);
      deletedKeys.push(key);
    }
  }

  return { domain: normalized, inbound: inboundCount, sent: sentCount, deletedKeys };
}

/** Delete the global send-log index (legacy). */
export async function deleteSendLogIndex(bucket: R2Bucket): Promise<boolean> {
  const key = "sent/_sendlog/_index.json";
  const object = await bucket.head(key);
  if (object) {
    await bucket.delete(key);
    return true;
  }
  return false;
}
