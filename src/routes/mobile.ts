import { Hono } from "hono";
import type { Env } from "../env";
import { requireMobilePassword, type MobileAuthResult } from "../lib/mobile-auth";
import { createAppDb } from "../../db/app";
import { createMailDb } from "../../db/mail";
import {
  mobileEnabledAddresses,
  readMailbox,
  updateAddressProfile,
  type MailboxAddress,
} from "../lib/catalog-store";
import {
  ackInboxNotifications,
  getInboxAttachmentResult,
  getInboxMessageForDomains,
  inboxCountsForDomains,
  listInboxForDomains,
  listInboxNotificationsForDomains,
  searchInboxForDomains,
  setInboxReadStateMultiDomain,
} from "../lib/mail/list-inbox";
import { MIN_SEARCH_QUERY_LENGTH } from "../lib/inbound-search";
import { serializeInboundListItem } from "../lib/inbound-serialize";
import { sendMailMessage, type SendMailBody } from "../lib/mail/send-message";
import { listMailboxPage } from "../../db/mail/messages";
import { createCloudflareClient } from "../lib/cloudflare-config";
import {
  collectSendingHealth,
  UNKNOWN_ERROR,
} from "../lib/sending-health";

const mobile = new Hono<{
  Bindings: Env;
  Variables: {
    mobileAuth: MobileAuthResult;
    mobileDomains: string[];
    mobileAddresses: MailboxAddress[];
    authEmail: string;
  };
}>();

/**
 * Load the mobile scope once per request. A team member signs in with ONE
 * account email + that account's password, so every `/mobile/*` route is
 * scoped to that single authenticated account — they must never see or send
 * from any other address, even on the same domain.
 */
mobile.use("*", async (c, next) => {
  const auth = await requireMobilePassword(c);
  if (auth instanceof Response) return auth;
  c.set("mobileAuth", auth);
  c.set("authEmail", auth.email);
  const data = await readMailbox(createAppDb(c.env.RELAYBASE_DB));
  const allEnabled = mobileEnabledAddresses(data);
  // Restrict to the single authenticated account only.
  const addresses = allEnabled.filter(
    (a) => a.email.toLowerCase() === auth.email,
  );
  const domains = addresses.map((a) => a.domain);
  c.set("mobileAddresses", addresses);
  c.set("mobileDomains", domains);
  await next();
});

/**
 * Same Email Sending probe as GET /mail/sending-health, scoped to this
 * teammate's domain. Cloudflare dashboard URLs are stripped — teammates
 * cannot fix onboarding; they should ask the owner.
 */
mobile.get("/sending-health", async (c) => {
  const domains = c.get("mobileDomains");
  let cf = null;
  let probeError: string | undefined;
  const callerAccountId = c.req.query("accountId");
  try {
    cf = await createCloudflareClient(c.env, {
      accountId: callerAccountId,
    });
  } catch (error) {
    probeError = error instanceof Error ? error.message : UNKNOWN_ERROR;
  }
  const snapshot = await collectSendingHealth(domains, cf, {
    accountId: callerAccountId || cf?.accountId || c.env.CF_ACCOUNT_ID,
    probeError,
  });
  return c.json({
    ...snapshot,
    domains: snapshot.domains.map((domain) => ({
      ...domain,
      cloudflareSendingUrl: null,
    })),
  });
});

/** Validate that the mobile session can connect. */
mobile.get("/config", async (c) => {
  // Auth already ran in the middleware; return minimal public metadata.
  const email = c.get("authEmail");
  return c.json({ ok: true, mobile: true, email });
});

/** The authenticated teammate's own profile (display name + signature). */
mobile.get("/profile", async (c) => {
  const addresses = c.get("mobileAddresses");
  const address = addresses[0];
  return c.json({
    ok: true,
    email: c.get("authEmail"),
    displayName: address?.displayName ?? "",
    signature: address?.signature ?? "",
  });
});

/** Update the teammate's own profile (display name + signature). */
mobile.patch("/profile", async (c) => {
  const email = c.get("authEmail");
  let body: { displayName?: unknown; signature?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const patch: { displayName?: string; signature?: string } = {};
  if (body.displayName !== undefined) {
    if (typeof body.displayName !== "string") {
      return c.json({ error: "displayName must be a string" }, 400);
    }
    const trimmed = body.displayName.trim();
    if (trimmed.length > 128) {
      return c.json({ error: "displayName must be 128 characters or fewer" }, 400);
    }
    patch.displayName = trimmed;
  }
  if (body.signature !== undefined) {
    if (typeof body.signature !== "string") {
      return c.json({ error: "signature must be a string" }, 400);
    }
    if (body.signature.length > 1024) {
      return c.json({ error: "signature must be 1024 characters or fewer" }, 400);
    }
    patch.signature = body.signature;
  }
  const updated = await updateAddressProfile(
    createAppDb(c.env.RELAYBASE_DB),
    email,
    patch,
  );
  if (!updated) {
    return c.json({ error: "Account not found" }, 404);
  }
  return c.json({
    ok: true,
    email: updated.email,
    displayName: updated.displayName ?? "",
    signature: updated.signature ?? "",
  });
});

/** All domains + addresses the mobile app is allowed to see. */
mobile.get("/mailbox", async (c) => {
  const addresses = c.get("mobileAddresses");
  const domains = c.get("mobileDomains");
  return c.json({
    domains,
    addresses: addresses.map((a) => ({
      email: a.email,
      domain: a.domain,
      displayName: a.displayName ?? null,
      inboundEnabled: a.inboundEnabled !== false,
    })),
  });
});

/** Inbox list across all mobile-enabled domains (Gmail "all inboxes"). */
mobile.get("/inbox", async (c) => {
  const domains = c.get("mobileDomains");
  const authEmail = c.get("authEmail");
  const account =
    c.req.query("account")?.trim().toLowerCase() ||
    authEmail ||
    undefined;
  const limit = Number(c.req.query("limit") ?? "50");
  const page = await listInboxForDomains(c.env, domains, {
    account,
    limit: Number.isFinite(limit) ? limit : 50,
  });
  return c.json({
    messages: page.messages,
    total: page.total,
    unread: page.unread,
  });
});

/**
 * Full-text search across mobile-enabled domains, always scoped to the
 * authenticated account's To+Cc membership. Flat results, newest first.
 */
mobile.get("/inbox/search", async (c) => {
  const domains = c.get("mobileDomains");
  const authEmail = c.get("authEmail");
  const q = c.req.query("q")?.trim() ?? "";
  if (q.length < MIN_SEARCH_QUERY_LENGTH) {
    return c.json(
      { error: `q must be at least ${MIN_SEARCH_QUERY_LENGTH} characters` },
      400,
    );
  }
  const limit = Number(c.req.query("limit") ?? "50");
  const before = c.req.query("before")?.trim() || undefined;
  const page = await searchInboxForDomains(c.env, domains, {
    q,
    limit: Number.isFinite(limit) ? limit : 50,
    before,
    account: authEmail,
  });
  if (!page) {
    return c.json({ error: "Search index is not configured" }, 503);
  }
  return c.json({
    messages: page.rows.map((row) =>
      serializeInboundListItem(rowToInboundMeta(row)),
    ),
    total: page.total,
    nextBefore: page.nextBefore,
    hasMore: page.hasMore,
  });
});

function rowToInboundMeta(row: {
  id: string;
  domain: string;
  from_email: string;
  from_name: string | null;
  to_email: string;
  to_emails: string | null;
  cc_emails: string | null;
  subject: string;
  occurred_at: string;
  message_id: string | null;
  in_reply_to: string | null;
  refs: string | null;
  size: number;
  attachment_count: number;
  read_at: string | null;
  body_preview: string;
}) {
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

/** Per-address total/unread counts across mobile-enabled domains. */
mobile.get("/inbox/counts", async (c) => {
  const domains = c.get("mobileDomains");
  const counts = await inboxCountsForDomains(c.env, domains);
  return c.json(counts);
});

/** Bulk mark read/unread. Body: `{ ids: string[], read: boolean }`. */
mobile.post("/inbox/read", async (c) => {
  const domains = c.get("mobileDomains");
  let body: { ids?: string[]; read?: boolean };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const ids = body.ids?.filter((id) => typeof id === "string" && id.trim());
  if (!ids?.length) {
    return c.json({ error: "ids must be a non-empty array" }, 400);
  }
  if (typeof body.read !== "boolean") {
    return c.json({ error: "read must be a boolean" }, 400);
  }
  const result = await setInboxReadStateMultiDomain(c.env, domains, ids, body.read);
  return c.json(result);
});

/** Message detail. Optional `?domain=` scopes the lookup to one domain. */
mobile.get("/inbox/:id", async (c) => {
  const domains = c.get("mobileDomains");
  const domainHint = c.req.query("domain")?.trim().toLowerCase();
  const lookupDomains = domainHint ? [domainHint] : domains;
  const message = await getInboxMessageForDomains(
    c.env,
    lookupDomains,
    c.req.param("id"),
  );
  if (!message) {
    return c.json({ error: "Message not found" }, 404);
  }
  return c.json({ message });
});

/** Attachment download. Requires `?domain=`. */
mobile.get("/inbox/:id/attachments/:attachmentId", async (c) => {
  const domains = c.get("mobileDomains");
  const domain = c.req.query("domain")?.trim().toLowerCase();
  if (!domain || !domains.includes(domain)) {
    return c.json({ error: "domain query parameter is required" }, 400);
  }
  const result = await getInboxAttachmentResult(c.env, {
    domain,
    messageId: c.req.param("id"),
    attachmentId: c.req.param("attachmentId"),
  });
  if (!result) {
    return c.json({ error: "Attachment not found" }, 404);
  }
  const encoded = encodeURIComponent(result.meta.filename);
  return new Response(result.body, {
    headers: {
      "Content-Type": result.meta.contentType,
      "Content-Disposition": `${result.meta.disposition === "inline" ? "inline" : "attachment"}; filename="${result.meta.filename}"; filename*=UTF-8''${encoded}`,
      "Cache-Control": "private, max-age=3600",
    },
  });
});

/** Sent history for the authenticated account (read from D1 mailbox_messages
 * kind=sent, scoped to the account's To+Cc membership). Ops log stays on
 * `/console/send-logs`. */
mobile.get("/sent", async (c) => {
  const domains = c.get("mobileDomains");
  const authEmail = c.get("authEmail");
  const mailDb = createMailDb(c.env.RELAYBASE_MAIL);
  if (!mailDb) {
    return c.json({ error: "Mail index is not configured" }, 503);
  }

  const limit = Number(c.req.query("limit") ?? "50");
  const before = c.req.query("before")?.trim() || undefined;

  const collected: Array<ReturnType<typeof rowToSentItem>> = [];
  let total = 0;
  for (const domain of domains) {
    const normalized = domain.trim().toLowerCase();
    if (!normalized) continue;
    const page = await listMailboxPage(mailDb, {
      kind: "sent",
      domain: normalized,
      account: authEmail,
      limit: Number.isFinite(limit) ? limit : 50,
      before,
    });
    total += page.total;
    for (const row of page.rows) collected.push(rowToSentItem(row));
  }
  collected.sort((a, b) => b.sentAt.localeCompare(a.sentAt));
  const sliced = collected.slice(0, Number.isFinite(limit) ? limit : 50);
  return c.json({
    sent: sliced,
    total,
    hasMore: total > sliced.length,
  });
});

function rowToSentItem(row: {
  id: string;
  domain: string;
  from_email: string;
  from_name: string | null;
  to_email: string;
  to_emails: string | null;
  cc_emails: string | null;
  subject: string;
  occurred_at: string;
  message_id: string | null;
  in_reply_to: string | null;
  refs: string | null;
  size: number;
  attachment_count: number;
  body_preview: string;
}) {
  return {
    id: row.id,
    from: row.from_email,
    fromName: row.from_name ?? null,
    to: row.to_emails ?? row.to_email,
    cc: row.cc_emails ?? "",
    subject: row.subject,
    bodyPreview: row.body_preview,
    sentAt: row.occurred_at,
    messageId: row.message_id,
    inReplyTo: row.in_reply_to,
    references: row.refs,
    size: row.size,
    attachmentCount: row.attachment_count,
  };
}

/** Send email. `from` must be a mobile-enabled address. */
mobile.post("/send", async (c) => {
  const addresses = c.get("mobileAddresses");
  const allowedFrom = new Set(addresses.map((a) => a.email.toLowerCase()));

  let body: SendMailBody;
  try {
    body = (await c.req.json()) as SendMailBody;
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const from = body.from?.trim().toLowerCase();
  if (!from || !allowedFrom.has(from)) {
    return c.json(
      { error: "From address is not enabled for mobile access" },
      403,
    );
  }

  const result = await sendMailMessage(c.env, body, "mobile", {
    waitUntil: (promise) => c.executionCtx.waitUntil(promise),
  });
  return result.response;
});

/** Polling surface for new mail across mobile-enabled domains. */
mobile.get("/notifications", async (c) => {
  const domains = c.get("mobileDomains");
  const limit = Number(c.req.query("limit") ?? "25");
  const events = await listInboxNotificationsForDomains(
    c.env,
    domains,
    Number.isFinite(limit) ? limit : 25,
  );
  return c.json({ events });
});

/** Ack pending events for one domain. Body: `{ domain, ids }`. */
mobile.post("/notifications/ack", async (c) => {
  const domains = c.get("mobileDomains");
  let body: { domain?: string; ids?: string[] };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const domain = body.domain?.trim().toLowerCase();
  if (!domain || !domains.includes(domain)) {
    return c.json({ error: "domain is required" }, 400);
  }
  const ids = body.ids?.filter((id) => typeof id === "string" && id.trim());
  if (!ids?.length) {
    return c.json({ error: "ids must be a non-empty array" }, 400);
  }
  const acked = await ackInboxNotifications(c.env, domain, ids);
  return c.json({ acked });
});

export { mobile };
