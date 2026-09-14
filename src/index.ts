import type { Env } from "./env";
import app from "./app";
import { handleInboundEmail } from "./inbound";
import { runAudienceCron } from "./lib/catalog/catalog-audience";
import { runInboundIndexCron } from "./lib/mail/inbound-index-cron";
import { runRoutingRepairCron } from "./lib/ops/routing-repair-cron";
import { enqueueInboundEvent } from "./lib/mail/inbound-events";
import { recordOpsLog } from "./lib/ops/ops-logs";
import { deliverWebhooks } from "./lib/catalog/webhooks";
import { createAppDb, type AppDb } from "../db/app";

async function dispatchInboundEvent(
  db: AppDb,
  record: Awaited<ReturnType<typeof handleInboundEmail>>["record"],
): Promise<void> {
  const event = await enqueueInboundEvent(db, record);
  await deliverWebhooks(db, record.domain, event);
}

export default {
  fetch: app.fetch,
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(
      runAudienceCron(createAppDb(env.RELAYBASE_DB)).catch((error) => {
        console.error("Audience cron failed", error);
      }),
    );
    ctx.waitUntil(
      runInboundIndexCron(env).catch((error) => {
        console.error("Inbound index cron failed", error);
      }),
    );
    ctx.waitUntil(
      runRoutingRepairCron(env).catch((error) => {
        console.error("Routing repair cron failed", error);
      }),
    );
  },
  async email(
    message: ForwardableEmailMessage,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    try {
      const { record, created } = await handleInboundEmail(message, env);
      if (created) {
        ctx.waitUntil(dispatchInboundEvent(createAppDb(env.RELAYBASE_DB), record));
      }
    } catch (error) {
      console.error("Failed to store inbound email", error);
      const to = message.to;
      const domain = to.includes("@")
        ? to.slice(to.lastIndexOf("@") + 1).trim().toLowerCase()
        : null;
      // Log the failure in the background (waitUntil) so a D1 write error
      // never swallows the original inbound error, and so the re-throw is
      // not delayed by the log write. Without this, a failed inbound that
      // reached the Worker but threw during R2/D1 storage would be missing
      // from the dashboard Log page.
      ctx.waitUntil(
        recordOpsLog(env.RELAYBASE_LOGS, {
          kind: "inbound",
          ok: false,
          source: "inbound",
          domain,
          fromAddr: message.from,
          toAddr: to,
          subject: message.headers.get("subject")?.trim() || null,
          messageId: message.headers.get("message-id")?.trim() || null,
          error:
            error instanceof Error
              ? error.message
              : "Failed to store inbound email",
        }).catch((logErr) => {
          console.error("Failed to record inbound error log", logErr);
        }),
      );
      throw error;
    }
  },
} satisfies ExportedHandler<Env>;
