import type { Env } from "./env";
import { createMailDb } from "../db/mail";
import {
  buildBouncePreview,
  isBounceMessage,
  parseBounceDiagnostic,
} from "./lib/bounce-detect";
import { recordOpsLog } from "./lib/ops-logs";
import {
  storeInboundMail,
  type StoreInboundMailResult,
} from "./lib/mailbox-store";

export async function handleInboundEmail(
  message: ForwardableEmailMessage,
  env: Env,
): Promise<StoreInboundMailResult> {
  const raw = await new Response(message.raw).arrayBuffer();
  const result = await storeInboundMail(
    env.INBOUND,
    {
      envelopeFrom: message.from,
      toEmail: message.to,
      subject: message.headers.get("subject")?.trim() || "(no subject)",
      messageId: message.headers.get("message-id")?.trim() || null,
      inReplyTo: message.headers.get("in-reply-to")?.trim() || null,
      references: message.headers.get("references")?.trim() || null,
      size: message.rawSize,
      raw,
    },
    createMailDb(env.RELAYBASE_MAIL),
  );

  await recordOpsLog(env.RELAYBASE_LOGS, {
    kind: "inbound",
    ok: true,
    source: "inbound",
    domain: result.record.domain,
    fromAddr: message.from,
    toAddr: message.to,
    subject: result.record.subject,
    messageId: result.record.messageId,
    metaJson: JSON.stringify({
      inboundId: result.record.id,
      created: result.created,
    }),
  });

  if (isBounceMessage(raw, message.from)) {
    const diagnostic = parseBounceDiagnostic(raw);
    const error = buildBouncePreview(diagnostic, "Bounce: delivery failed");
    await recordOpsLog(env.RELAYBASE_LOGS, {
      kind: "bounce",
      ok: false,
      source: "inbound",
      domain: result.record.domain,
      fromAddr: message.from,
      toAddr: diagnostic.finalRecipient ?? message.to,
      subject: result.record.subject,
      messageId: result.record.messageId,
      error,
      metaJson: JSON.stringify({
        inboundId: result.record.id,
        dsnStatus: diagnostic.status,
        diagnosticCode: diagnostic.diagnosticCode,
      }),
    });
  }

  return result;
}
