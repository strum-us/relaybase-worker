import { Hono } from "hono";
import type { Env } from "../env";
import { requireApiKey } from "../lib/auth";
import { createAppDb } from "../../db/app";
import { createMailDb } from "../../db/mail";
import {
  ackPendingEvents,
  listPendingEvents,
} from "../lib/inbound-events";
import {
  getInboundAttachment,
  getMailMessage,
  setMailReadState,
} from "../lib/mailbox-store";
import {
  MIN_SEARCH_QUERY_LENGTH,
} from "../lib/inbound-search";
import {
  serializeInboundListItem,
  serializeInboundMessage,
} from "../lib/inbound-serialize";
import {
  listMailboxPage,
  mailboxAddressCounts,
} from "../../db/mail/messages";
import {
  searchMailbox,
} from "../../db/mail/search";

const v1Inbox = new Hono<{ Bindings: Env }>();

v1Inbox.get("/events", async (c) => {
  const auth = await requireApiKey(c);
  if (auth instanceof Response) return auth;

  const limit = Number(c.req.query("limit") ?? "25");
  const events = await listPendingEvents(createAppDb(c.env.RELAYBASE_DB), auth.record.domain, limit);
  return c.json({ events });
});

v1Inbox.post("/events/ack", async (c) => {
  const auth = await requireApiKey(c);
  if (auth instanceof Response) return auth;

  let body: { ids?: string[] };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const ids = body.ids?.filter((id) => typeof id === "string" && id.trim());
  if (!ids?.length) {
    return c.json({ error: "ids must be a non-empty array" }, 400);
  }

  const acked = await ackPendingEvents(createAppDb(c.env.RELAYBASE_DB), auth.record.domain, ids);
  return c.json({ acked });
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

v1Inbox.get("/messages", async (c) => {
  const auth = await requireApiKey(c);
  if (auth instanceof Response) return auth;

  const mailDb = createMailDb(c.env.RELAYBASE_MAIL);
  if (!mailDb) {
    return c.json({ error: "Mail index is not configured" }, 503);
  }

  const limit = Number(c.req.query("limit") ?? "50");
  const before = c.req.query("before")?.trim() || undefined;
  const page = await listMailboxPage(mailDb, {
    kind: "inbound",
    domain: auth.record.domain,
    limit: Number.isFinite(limit) ? limit : 50,
    before,
  });

  return c.json({
    messages: page.rows.map((row) =>
      serializeInboundListItem(rowToInboundMeta(row)),
    ),
    nextBefore: page.nextBefore,
    hasMore: page.hasMore,
    total: page.total,
    unread: page.unread,
  });
});

v1Inbox.get("/messages/counts", async (c) => {
  const auth = await requireApiKey(c);
  if (auth instanceof Response) return auth;

  const mailDb = createMailDb(c.env.RELAYBASE_MAIL);
  if (!mailDb) {
    return c.json({ error: "Mail index is not configured" }, 503);
  }
  const byAddress = await mailboxAddressCounts(mailDb, "inbound", auth.record.domain);
  let totalAll = 0;
  let unreadAll = 0;
  const counts: Record<string, { total: number; unread: number }> = {};
  for (const [address, value] of Object.entries(byAddress)) {
    counts[address] = value;
    totalAll += value.total;
    unreadAll += value.unread;
  }
  return c.json({ counts, totalAll, unreadAll });
});

// Server-side full-text search (subject/from/to/cc/body). Flat results.
v1Inbox.get("/messages/search", async (c) => {
  const auth = await requireApiKey(c);
  if (auth instanceof Response) return auth;

  const q = c.req.query("q")?.trim() ?? "";
  if (q.length < MIN_SEARCH_QUERY_LENGTH) {
    return c.json(
      { error: `q must be at least ${MIN_SEARCH_QUERY_LENGTH} characters` },
      400,
    );
  }
  const mailDb = createMailDb(c.env.RELAYBASE_MAIL);
  if (!mailDb) {
    return c.json({ error: "Mail index is not configured" }, 503);
  }

  const limit = Number(c.req.query("limit") ?? "50");
  const before = c.req.query("before")?.trim() || undefined;
  const page = await searchMailbox(mailDb, {
    kind: "inbound",
    domains: [auth.record.domain],
    q,
    limit: Number.isFinite(limit) ? limit : 50,
    before,
  });

  return c.json({
    messages: page.rows.map((row) =>
      serializeInboundListItem(rowToInboundMeta(row)),
    ),
    total: page.total,
    nextBefore: page.nextBefore,
    hasMore: page.hasMore,
  });
});

v1Inbox.post("/messages/read", async (c) => {
  const auth = await requireApiKey(c);
  if (auth instanceof Response) return auth;

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

  const readAt = body.read ? new Date().toISOString() : null;
  const result = await setMailReadState(
    c.env.INBOUND,
    auth.record.domain,
    ids,
    readAt,
    createMailDb(c.env.RELAYBASE_MAIL),
  );
  return c.json(result);
});

v1Inbox.get("/messages/:id/attachments/:attachmentId", async (c) => {
  const auth = await requireApiKey(c);
  if (auth instanceof Response) return auth;

  const result = await getInboundAttachment(c.env.INBOUND, {
    domain: auth.record.domain,
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

v1Inbox.get("/messages/:id", async (c) => {
  const auth = await requireApiKey(c);
  if (auth instanceof Response) return auth;

  const message = await getMailMessage(
    c.env.INBOUND,
    "inbound",
    auth.record.domain,
    c.req.param("id"),
  );
  if (!message || message.domain !== auth.record.domain) {
    return c.json({ error: "Message not found" }, 404);
  }

  return c.json({ message: serializeInboundMessage(message) });
});

export { v1Inbox };
