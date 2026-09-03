import type { Env } from "../../env";
import { createAppDb, type AppDb } from "../../../db/app";
import { createMailDb } from "../../../db/mail";
import { readMailbox } from "../catalog-store";
import { enqueueInboundEvent } from "../inbound-events";
import { storeInboundMail, type InboundEmailMeta } from "../mailbox-store";
import { deliverWebhooks } from "../webhooks";
import { selectLocalInboundRecipients } from "./local-deliver-select";

export type LocalDeliverWaitUntil = (promise: Promise<unknown>) => void;
export { selectLocalInboundRecipients };

async function dispatchLocalInboundEvent(
  db: AppDb,
  record: InboundEmailMeta,
): Promise<void> {
  const event = await enqueueInboundEvent(db, record);
  await deliverWebhooks(db, record.domain, event);
}

/**
 * After a successful outbound send, ingest a copy into each local
 * `inbound_enabled` mailbox. Cloudflare Email Sending accept is not delivery
 * into `email()` — same-account hairpins can drop silently. Local ingest
 * makes Inbox match Sent for on-install recipients. Failures never throw.
 */
export async function deliverToLocalInboxes(
  env: Env,
  params: {
    from: string;
    to: string[];
    cc?: string[];
    subject: string;
    messageId: string | null;
    inReplyTo?: string | null;
    references?: string | null;
    rawMime: string;
    skipAddresses?: string[];
    waitUntil?: LocalDeliverWaitUntil;
  },
): Promise<void> {
  if (!env.INBOUND) return;

  try {
    const appDb = createAppDb(env.RELAYBASE_DB);
    const mailbox = await readMailbox(appDb);
    const local = selectLocalInboundRecipients(
      [...params.to, ...(params.cc ?? [])],
      mailbox.addresses,
      params.skipAddresses,
    );
    if (local.length === 0) return;

    const raw = new TextEncoder().encode(params.rawMime);
    const rawBuffer = raw.buffer.slice(
      raw.byteOffset,
      raw.byteOffset + raw.byteLength,
    ) as ArrayBuffer;
    const mailDb = createMailDb(env.RELAYBASE_MAIL);

    for (const toEmail of local) {
      try {
        const { record, created } = await storeInboundMail(
          env.INBOUND,
          {
            envelopeFrom: params.from,
            toEmail,
            subject: params.subject,
            messageId: params.messageId,
            inReplyTo: params.inReplyTo ?? null,
            references: params.references ?? null,
            size: raw.byteLength,
            raw: rawBuffer,
          },
          mailDb,
        );
        if (!created) continue;
        const notify = dispatchLocalInboundEvent(appDb, record);
        if (params.waitUntil) {
          params.waitUntil(
            notify.catch((error) => {
              console.error("Failed to dispatch local inbound event", error);
            }),
          );
        } else {
          await notify;
        }
      } catch (error) {
        console.error("Failed to locally deliver inbound mail", toEmail, error);
      }
    }
  } catch (error) {
    console.error("Failed to locally deliver inbound mail", error);
  }
}
