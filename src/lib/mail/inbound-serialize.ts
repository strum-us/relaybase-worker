import type { InboundEmailMeta } from "./mailbox-store";
import { decodeMimeHeader } from "./mime-parse";

export function decodeSubject(subject: string): string {
  return decodeMimeHeader(subject) || subject || "(no subject)";
}

export function serializeInboundListItem(message: InboundEmailMeta) {
  return {
    key: message.id,
    fromEmail: message.fromEmail,
    fromName: message.fromName ?? null,
    toEmail: message.toEmail,
    toEmails: message.toEmails?.length ? message.toEmails : [message.toEmail],
    ccEmails: message.ccEmails ?? [],
    subject: decodeSubject(message.subject),
    status: "stored",
    action: "worker",
    receivedAt: message.receivedAt,
    bodyPreview: message.bodyPreview,
    attachmentCount: message.attachments.length,
    messageId: message.messageId,
    inReplyTo: message.inReplyTo ?? null,
    references: message.references ?? null,
    size: message.size,
    readAt: message.readAt ?? null,
  };
}

export function serializeInboundMessage(message: InboundEmailMeta) {
  return {
    key: message.id,
    fromEmail: message.fromEmail,
    fromName: message.fromName ?? null,
    toEmail: message.toEmail,
    toEmails: message.toEmails?.length ? message.toEmails : [message.toEmail],
    ccEmails: message.ccEmails ?? [],
    subject: decodeSubject(message.subject),
    status: "stored",
    action: "worker",
    receivedAt: message.receivedAt,
    bodyPreview: message.bodyPreview,
    bodyText: message.bodyText,
    bodyHtml: message.bodyHtml,
    messageId: message.messageId,
    inReplyTo: message.inReplyTo ?? null,
    references: message.references ?? null,
    size: message.size,
    readAt: message.readAt ?? null,
    attachments: message.attachments.map((attachment) => ({
      ...attachment,
      filename: decodeMimeHeader(attachment.filename) || attachment.filename,
    })),
  };
}
