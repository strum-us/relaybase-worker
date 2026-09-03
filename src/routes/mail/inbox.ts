import { Hono } from "hono";
import type { Env } from "../../env";
import { requireMailSession } from "../../lib/auth";
import { createCloudflareClient } from "../../lib/cloudflare-config";
import { createAppDb } from "../../../db/app";
import { createMailDb } from "../../../db/mail";
import {
  ensureInboundRouting,
  listInboundRouting,
  removeInboundWorkerRouting,
  type InboundRoutingResult,
  type RemoveInboundRoutingResult,
} from "../../lib/inbound-routing";
import {
  getInboundAttachment,
  getMailMessage,
  setMailReadState,
} from "../../lib/mailbox-store";
import {
  MIN_SEARCH_QUERY_LENGTH,
} from "../../lib/inbound-search";
import {
  serializeInboundListItem,
  serializeInboundMessage,
} from "../../lib/inbound-serialize";
import {
  listMailboxPage,
  mailboxAddressCounts,
} from "../../../db/mail/messages";
import {
  searchMailbox,
} from "../../../db/mail/search";
import { readMailbox } from "../../lib/catalog-store";

const mailInbox = new Hono<{ Bindings: Env }>();

// Consumed by the desktop mail client (poll + ack) for live inbox updates.
mailInbox.get("/notifications", async (c) => {
  const denied = await requireMailSession(c);
  if (denied) return denied;

  const domain = c.req.query("domain")?.trim().toLowerCase();
  if (!domain) {
    return c.json({ error: "domain query parameter is required" }, 400);
  }

  const limit = Number(c.req.query("limit") ?? "25");
  const { listPendingEvents } = await import("../../lib/inbound-events");
  const events = await listPendingEvents(createAppDb(c.env.RELAYBASE_DB), domain, limit);
  return c.json({ events });
});

mailInbox.post("/notifications/ack", async (c) => {
  const denied = await requireMailSession(c);
  if (denied) return denied;

  let body: { domain?: string; ids?: string[] };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const domain = body.domain?.trim().toLowerCase();
  const ids = body.ids?.filter((id) => typeof id === "string" && id.trim());
  if (!domain) {
    return c.json({ error: "domain is required" }, 400);
  }
  if (!ids?.length) {
    return c.json({ error: "ids must be a non-empty array" }, 400);
  }

  const { ackPendingEvents } = await import("../../lib/inbound-events");
  const acked = await ackPendingEvents(createAppDb(c.env.RELAYBASE_DB), domain, ids);
  return c.json({ acked });
});

function serializeMessage(message: Awaited<ReturnType<typeof getMailMessage>>) {
  if (!message) return null;
  return serializeInboundMessage(message);
}

// Per-address total/unread counts across every retained message for a
// domain — powers the dashboard Accounts list.
mailInbox.get("/counts", async (c) => {
  const denied = await requireMailSession(c);
  if (denied) return denied;

  const domain = c.req.query("domain")?.trim().toLowerCase();
  if (!domain) {
    return c.json({ error: "domain query parameter is required" }, 400);
  }

  const mailDb = createMailDb(c.env.RELAYBASE_MAIL);
  if (!mailDb) {
    return c.json({ error: "Mail index is not configured" }, 503);
  }
  const byAddress = await mailboxAddressCounts(mailDb, "inbound", domain);
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

// Server-side full-text search (subject/from/to/cc/body) over the D1 FTS
// index. Results are flat messages (no thread grouping), newest first.
mailInbox.get("/search", async (c) => {
  const denied = await requireMailSession(c);
  if (denied) return denied;

  const domain = c.req.query("domain")?.trim().toLowerCase();
  if (!domain) {
    return c.json({ error: "domain query parameter is required" }, 400);
  }
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
    domains: [domain],
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

// Bulk mark-read/unread (desktop client + Cmd+K mail commands).
mailInbox.post("/read", async (c) => {
  const denied = await requireMailSession(c);
  if (denied) return denied;

  let body: { domain?: string; ids?: string[]; read?: boolean };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const domain = body.domain?.trim().toLowerCase();
  const ids = body.ids?.filter((id) => typeof id === "string" && id.trim());
  if (!domain) {
    return c.json({ error: "domain is required" }, 400);
  }
  if (!ids?.length) {
    return c.json({ error: "ids must be a non-empty array" }, 400);
  }
  if (typeof body.read !== "boolean") {
    return c.json({ error: "read must be a boolean" }, 400);
  }

  const readAt = body.read ? new Date().toISOString() : null;
  const result = await setMailReadState(
    c.env.INBOUND,
    domain,
    ids,
    readAt,
    createMailDb(c.env.RELAYBASE_MAIL),
  );
  return c.json(result);
});

mailInbox.get("/", async (c) => {
  const denied = await requireMailSession(c);
  if (denied) return denied;

  const domain = c.req.query("domain")?.trim().toLowerCase();
  if (!domain) {
    return c.json({ error: "domain query parameter is required" }, 400);
  }

  const mailDb = createMailDb(c.env.RELAYBASE_MAIL);
  if (!mailDb) {
    return c.json({ error: "Mail index is not configured" }, 503);
  }

  const limit = Number(c.req.query("limit") ?? "50");
  const before = c.req.query("before")?.trim() || undefined;
  const page = await listMailboxPage(mailDb, {
    kind: "inbound",
    domain,
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

mailInbox.get("/:id/attachments/:attachmentId", async (c) => {
  const denied = await requireMailSession(c);
  if (denied) return denied;

  const domain = c.req.query("domain")?.trim().toLowerCase();
  if (!domain) {
    return c.json({ error: "domain query parameter is required" }, 400);
  }

  const result = await getInboundAttachment(c.env.INBOUND, {
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

mailInbox.get("/routing", async (c) => {
  const denied = await requireMailSession(c);
  if (denied) return denied;

  const mailbox = await readMailbox(createAppDb(c.env.RELAYBASE_DB));
  const requested = c.req.query("domain")?.trim().toLowerCase();
  const domains = requested
    ? [requested]
    : mailbox.domains.map((domain) => domain.trim().toLowerCase()).filter(Boolean);

  try {
    const cf = await createCloudflareClient(c.env);
    const results = await Promise.all(
      domains.map(async (domain) => {
        try {
          return await listInboundRouting(cf, domain);
        } catch (error) {
          return {
            domain,
            error:
              error instanceof Error ? error.message : "Failed to list routing",
          };
        }
      }),
    );
    return c.json({ domains: results });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to list routing";
    return c.json({ error: message }, 502);
  }
});

mailInbox.post("/routing", async (c) => {
  const denied = await requireMailSession(c);
  if (denied) return denied;

  let body: { domain?: string; addresses?: string[] };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const domain = body.domain?.trim().toLowerCase();
  const addresses = body.addresses
    ?.map((address) => address.trim().toLowerCase())
    .filter(Boolean);
  if (!domain) {
    return c.json({ error: "domain is required" }, 400);
  }
  if (!addresses?.length) {
    return c.json({ error: "addresses must be a non-empty array" }, 400);
  }

  try {
    const mailbox = await readMailbox(createAppDb(c.env.RELAYBASE_DB));
    const byEmail = new Map(
      mailbox.addresses.map((a) => [a.email.toLowerCase(), a] as const),
    );
    const entries = addresses.map((address) => ({
      address,
      inboundEnabled: byEmail.get(address)?.inboundEnabled !== false,
    }));
    const cf = await createCloudflareClient(c.env);
    const result: InboundRoutingResult = await ensureInboundRouting(
      cf,
      domain,
      entries,
      c.env.WORKER_SCRIPT_NAME,
    );
    return c.json(result);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to configure routing";
    return c.json({ error: message }, 502);
  }
});

mailInbox.delete("/routing", async (c) => {
  const denied = await requireMailSession(c);
  if (denied) return denied;

  let body: { domain?: string; addresses?: string[] };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const domain = body.domain?.trim().toLowerCase();
  const addresses = body.addresses
    ?.map((address) => address.trim().toLowerCase())
    .filter(Boolean);
  if (!domain) {
    return c.json({ error: "domain is required" }, 400);
  }
  if (!addresses?.length) {
    return c.json({ error: "addresses must be a non-empty array" }, 400);
  }

  try {
    const cf = await createCloudflareClient(c.env);
    const result: RemoveInboundRoutingResult = await removeInboundWorkerRouting(
      cf,
      domain,
      addresses,
    );
    return c.json(result);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to remove routing";
    return c.json({ error: message }, 502);
  }
});

mailInbox.get("/:id", async (c) => {
  const denied = await requireMailSession(c);
  if (denied) return denied;

  const domain = c.req.query("domain")?.trim().toLowerCase();
  if (!domain) {
    return c.json({ error: "domain query parameter is required" }, 400);
  }
  const message = await getMailMessage(c.env.INBOUND, "inbound", domain, c.req.param("id"));
  if (!message) {
    return c.json({ error: "Message not found" }, 404);
  }

  return c.json({ message: serializeMessage(message) });
});

export { mailInbox };
