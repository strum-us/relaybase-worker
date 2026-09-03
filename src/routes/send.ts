import { Hono } from "hono";
import type { Env } from "../env";
import { requireApiKey } from "../lib/auth";
import { emailMatchesDomain } from "../lib/crypto";
import { cloudflareSendErrorBody } from "../lib/cloudflare-api-hints";
import { sendOutboundEmail } from "../lib/email-send";
import { recordOpsLog } from "../lib/ops-logs";
import { recordSendLog } from "../lib/send-logs";
import { createMailDb } from "../../db/mail";
import { storeSentMail } from "../lib/mailbox-store";
import { buildMimeMessage } from "../lib/mime";
import { deliverToLocalInboxes } from "../lib/mail/local-deliver";
import {
  findInvalidRecipients,
  normalizeRecipients,
} from "../lib/recipients";
import type { KeyRecord } from "../lib/keys";

const send = new Hono<{ Bindings: Env }>();

type SendBody = {
  from?: string;
  fromName?: string;
  to?: string | string[];
  cc?: string | string[];
  subject?: string;
  text?: string;
  html?: string;
  replyTo?: string;
  inReplyTo?: string;
  references?: string;
};

function keyFields(record: KeyRecord | null) {
  return {
    domain: record?.domain ?? null,
    keyId: record?.id ?? null,
    keyPrefix: record?.keyPrefix ?? null,
    keyLabel: record?.label ?? null,
  };
}

async function logAndRespond(
  c: { env: Env; json: (body: unknown, status?: number) => Response },
  params: {
    ok: boolean;
    status: number;
    body: unknown;
    record?: KeyRecord | null;
    from?: string | null;
    to?: string | null;
    subject?: string | null;
    messageId?: string;
    error?: string;
    metaJson?: string;
    opsOk?: boolean;
  },
): Promise<Response> {
  const fields = keyFields(params.record ?? null);
  try {
    await recordSendLog(c.env.INBOUND, {
      ok: params.ok,
      status: params.status,
      ...fields,
      from: params.from ?? null,
      to: params.to ?? null,
      subject: params.subject ?? null,
      messageId: params.messageId,
      error: params.error,
    });
  } catch (error) {
    console.error("Failed to record send log", error);
  }
  try {
    await recordOpsLog(c.env.RELAYBASE_LOGS, {
      kind: "send",
      ok: params.opsOk ?? params.ok,
      status: params.status,
      source: "api",
      domain: fields.domain,
      fromAddr: params.from ?? null,
      toAddr: params.to ?? null,
      subject: params.subject ?? null,
      messageId: params.messageId ?? null,
      error: params.error ?? null,
      keyId: fields.keyId,
      keyPrefix: fields.keyPrefix,
      metaJson: params.metaJson ?? null,
    });
  } catch (error) {
    console.error("Failed to record ops log", error);
  }
  return c.json(params.body, params.status);
}

send.post("/", async (c) => {
  const auth = await requireApiKey(c);
  if (auth instanceof Response) {
    try {
      await recordSendLog(c.env.INBOUND, {
        ok: false,
        status: 401,
        domain: null,
        keyId: null,
        keyPrefix: null,
        keyLabel: null,
        from: null,
        to: null,
        subject: null,
        error: "Invalid or missing API key",
      });
    } catch (error) {
      console.error("Failed to record send log", error);
    }
    try {
      await recordOpsLog(c.env.RELAYBASE_LOGS, {
        kind: "api_error",
        ok: false,
        status: 401,
        source: "api",
        error: "Invalid or missing API key",
      });
    } catch (error) {
      console.error("Failed to record ops log", error);
    }
    return auth;
  }
  const { record } = auth;

  let body: SendBody;
  try {
    body = await c.req.json();
  } catch {
    return logAndRespond(c, {
      ok: false,
      status: 400,
      body: { error: "Invalid JSON body" },
      record,
      error: "Invalid JSON body",
    });
  }

  const from = body.from?.trim();
  const to = normalizeRecipients(body.to);
  const cc = normalizeRecipients(body.cc);
  const subject = body.subject?.trim();
  const text = body.text?.trim();

  if (!from || !to.length || !subject || !text) {
    return logAndRespond(c, {
      ok: false,
      status: 400,
      body: { error: "from, to, subject, and text are required" },
      record,
      from: from ?? null,
      to: to.join(", ") || null,
      subject: subject ?? null,
      error: "from, to, subject, and text are required",
    });
  }

  const invalid = [
    ...findInvalidRecipients(to),
    ...findInvalidRecipients(cc),
  ];
  if (invalid.length) {
    return logAndRespond(c, {
      ok: false,
      status: 400,
      body: { error: `Invalid email address: ${invalid.join(", ")}` },
      record,
      from,
      to: to.join(", "),
      subject,
      error: `Invalid email address: ${invalid.join(", ")}`,
    });
  }

  if (!emailMatchesDomain(from, record.domain)) {
    return logAndRespond(c, {
      ok: false,
      status: 403,
      body: { error: `From address must be on ${record.domain}` },
      record,
      from,
      to: to.join(", "),
      subject,
      error: `From address must be on ${record.domain}`,
    });
  }

  try {
    const result = await sendOutboundEmail(c.env, {
      from,
      fromName: body.fromName?.trim() || undefined,
      to: to.length === 1 ? to[0] : to,
      cc: cc.length ? (cc.length === 1 ? cc[0] : cc) : undefined,
      subject,
      text,
      html: body.html,
      replyTo: body.replyTo,
      inReplyTo: body.inReplyTo?.trim() || undefined,
      references: body.references?.trim() || undefined,
    });
    // CF returns per-recipient disposition. Fail closed only when every
    // recipient is in permanent_bounces. Empty delivered/queued without
    // bounces is not a failure signal — CF can accept the message and
    // deliver it asynchronously while leaving the disposition arrays empty.
    // Asynchronous bounces arrive later as DSN inbound mail and are logged
    // separately with kind="bounce".
    const hadBounces = result.permanentBounces.length > 0;
    const meta = JSON.stringify({
      delivered: result.delivered,
      queued: result.queued,
      ...(hadBounces ? { permanentBounces: result.permanentBounces } : {}),
    });

    if (
      result.delivered.length === 0 &&
      result.queued.length === 0 &&
      hadBounces
    ) {
      const error = `All recipients permanently bounced: ${result.permanentBounces.join(", ")}`;
      return logAndRespond(c, {
        ok: false,
        status: 502,
        body: { error, messageId: result.messageId },
        record,
        from,
        to: to.join(", "),
        subject,
        messageId: result.messageId,
        error,
        metaJson: meta,
      });
    }
    const rawMime = buildMimeMessage({
      from,
      fromName: body.fromName?.trim() || undefined,
      to: to.length === 1 ? to[0] : to,
      cc: cc.length ? cc : undefined,
      subject,
      text,
      html: body.html,
      replyTo: body.replyTo,
      messageId: result.messageId,
      inReplyTo: body.inReplyTo?.trim() || undefined,
      references: body.references?.trim() || undefined,
    });
    try {
      await storeSentMail(
        c.env.INBOUND,
        {
          from,
          fromName: body.fromName?.trim() || undefined,
          to,
          cc: cc.length ? cc : undefined,
          subject,
          text,
          html: body.html,
          messageId: result.messageId,
          inReplyTo: body.inReplyTo?.trim() || null,
          references: body.references?.trim() || null,
          rawMime,
        },
        createMailDb(c.env.RELAYBASE_MAIL),
      );
    } catch (error) {
      console.error("Failed to persist sent mail", error);
    }
    await deliverToLocalInboxes(c.env, {
      from,
      to,
      cc: cc.length ? cc : undefined,
      subject,
      messageId: result.messageId,
      inReplyTo: body.inReplyTo?.trim() || null,
      references: body.references?.trim() || null,
      rawMime,
      skipAddresses: result.permanentBounces,
      waitUntil: (promise) => c.executionCtx.waitUntil(promise),
    });
    return logAndRespond(c, {
      ok: true,
      opsOk: !hadBounces,
      status: 200,
      body: { messageId: result.messageId },
      record,
      from,
      to: to.join(", "),
      subject,
      messageId: result.messageId,
      error: hadBounces
        ? `Some recipients permanently bounced: ${result.permanentBounces.join(", ")}`
        : undefined,
      metaJson: meta,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to send email";
    return logAndRespond(c, {
      ok: false,
      status: 502,
      body: cloudflareSendErrorBody(message),
      record,
      from,
      to: to.join(", "),
      subject,
      error: message,
    });
  }
});

export { send };
