import type { InboundEmailMeta } from "./mailbox-store";
import type { AppDb } from "../../db/app";
import {
  ackPendingEventRows as dbAckPendingEventRows,
  enqueueInboundEventRow as dbEnqueueInboundEventRow,
  listPendingEventRows as dbListPendingEventRows,
} from "../../db/app/inbound-events";

export type InboundEmailEvent = {
  id: string;
  type: "inbound.email.received";
  createdAt: string;
  data: {
    messageId: string;
    domain: string;
    from: string;
    to: string;
    subject: string;
    preview: string;
    receivedAt: string;
    hasAttachments: boolean;
  };
};

export async function enqueueInboundEvent(
  db: AppDb,
  meta: InboundEmailMeta,
): Promise<InboundEmailEvent> {
  const eventId = `evt_${meta.id}`;
  const event: InboundEmailEvent = {
    id: eventId,
    type: "inbound.email.received",
    createdAt: new Date().toISOString(),
    data: {
      messageId: meta.id,
      domain: meta.domain,
      from: meta.fromEmail,
      to: meta.toEmail,
      subject: meta.subject,
      preview: meta.bodyPreview,
      receivedAt: meta.receivedAt,
      hasAttachments: meta.attachments.length > 0,
    },
  };

  await dbEnqueueInboundEventRow(db, event);

  return event;
}

export async function listPendingEvents(
  db: AppDb,
  domain: string,
  limit = 25,
): Promise<InboundEmailEvent[]> {
  const events = await dbListPendingEventRows(db, domain, limit);
  events.sort((a, b) => b.data.receivedAt.localeCompare(a.data.receivedAt));
  return events;
}

export async function ackPendingEvents(
  db: AppDb,
  domain: string,
  ids: string[],
): Promise<number> {
  return dbAckPendingEventRows(db, domain, ids);
}
