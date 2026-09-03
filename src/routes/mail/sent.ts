import { Hono } from "hono";
import type { Env } from "../../env";
import { requireMailSession } from "../../lib/auth";
import { createMailDb } from "../../../db/mail";
import {
  getMailMessage,
  getMailAttachment,
} from "../../lib/mailbox-store";
import {
  listMailboxPage,
} from "../../../db/mail/messages";
import {
  searchMailbox,
} from "../../../db/mail/search";
import { MIN_SEARCH_QUERY_LENGTH } from "../../lib/inbound-search";

const mailSent = new Hono<{ Bindings: Env }>();

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

// Cursor-paginated (newest first). Reads from D1 `mailbox_messages`
// (kind=sent). Optional `q` runs an FTS5 search over subject/from/to/cc/body.
mailSent.get("/", async (c) => {
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

  const rawLimit = c.req.query("limit");
  const limit = rawLimit ? Number(rawLimit) : 5000;
  const before = c.req.query("before")?.trim() || undefined;
  const q = c.req.query("q")?.trim() || undefined;

  if (q && q.length >= MIN_SEARCH_QUERY_LENGTH) {
    const page = await searchMailbox(mailDb, {
      kind: "sent",
      domains: [domain],
      q,
      limit: Number.isFinite(limit) ? limit : 50,
      before,
    });
    return c.json({
      sent: page.rows.map(rowToSentItem),
      nextBefore: page.nextBefore,
      hasMore: page.hasMore,
      total: page.total,
    });
  }

  const page = await listMailboxPage(mailDb, {
    kind: "sent",
    domain,
    limit: Number.isFinite(limit) ? limit : 5000,
    before,
  });

  return c.json({
    sent: page.rows.map(rowToSentItem),
    nextBefore: page.nextBefore,
    hasMore: page.hasMore,
    total: page.total,
  });
});

// Sent message detail. Parses `raw.eml` on demand. Legacy sent rows imported
// from `_list.json` have no `raw.eml` — `bodyText` stays empty and only the
// `bodyPreview` is returned.
mailSent.get("/:id", async (c) => {
  const denied = await requireMailSession(c);
  if (denied) return denied;

  const domain = c.req.query("domain")?.trim().toLowerCase();
  if (!domain) {
    return c.json({ error: "domain query parameter is required" }, 400);
  }

  const message = await getMailMessage(c.env.INBOUND, "sent", domain, c.req.param("id"));
  if (!message) {
    return c.json({ error: "Message not found" }, 404);
  }

  return c.json({
    message: {
      key: message.id,
      fromEmail: message.fromEmail,
      fromName: message.fromName ?? null,
      toEmail: message.toEmail,
      toEmails: message.toEmails?.length ? message.toEmails : [message.toEmail],
      ccEmails: message.ccEmails ?? [],
      subject: message.subject,
      sentAt: message.receivedAt,
      bodyPreview: message.bodyPreview,
      bodyText: message.bodyText,
      bodyHtml: message.bodyHtml,
      messageId: message.messageId,
      inReplyTo: message.inReplyTo ?? null,
      references: message.references ?? null,
      size: message.size,
      attachments: message.attachments,
    },
  });
});

mailSent.get("/:id/attachments/:attachmentId", async (c) => {
  const denied = await requireMailSession(c);
  if (denied) return denied;

  const domain = c.req.query("domain")?.trim().toLowerCase();
  if (!domain) {
    return c.json({ error: "domain query parameter is required" }, 400);
  }

  const result = await getMailAttachment(c.env.INBOUND, "sent", {
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

export { mailSent };
