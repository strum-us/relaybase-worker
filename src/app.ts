import { Hono } from "hono";
import type { Env } from "./env";
import { desktopCors } from "./lib/cors";
import { probeD1Connection } from "./lib/d1-status";
import { consoleAudienceGroups } from "./routes/console/audience-groups";
import { consoleOpsLogs } from "./routes/console/ops-logs";
import { consoleOwnerAuth } from "./routes/console/owner-auth";
import { consoleRebuildMail } from "./routes/console/rebuild-mail";
import { consoleRegisterOwner } from "./routes/console/register-owner";
import { consoleSendLogs } from "./routes/console/send-logs";
import { consoleStats } from "./routes/console/stats";
import { consoleBroadcasts } from "./routes/console/broadcasts";
import { consoleConnect } from "./routes/console/connect";
import { consoleInitDb } from "./routes/console/init-db";
import { consoleMigrateDb } from "./routes/console/migrate-db";
import {
  consoleAddresses,
  consoleDomains,
  consoleMailbox,
} from "./routes/console/mailbox";
import { consoleBranding } from "./routes/console/branding";
import { consoleKeys } from "./routes/console/keys";
import { consoleMailboxHealth } from "./routes/console/mailbox-health";
import { consoleSettings } from "./routes/console/settings";
import { consoleSendingOnboard } from "./routes/console/sending-onboard";
import { consoleZones } from "./routes/console/zones";
import { mailAddresses } from "./routes/mail/addresses";
import { mailFavicon } from "./routes/mail/favicon";
import { mailInbox } from "./routes/mail/inbox";
import { mailSend } from "./routes/mail/send";
import { mailSendingHealth } from "./routes/mail/sending-health";
import { mailSent } from "./routes/mail/sent";
import { mobile } from "./routes/mobile";
import { send } from "./routes/send";
import { v1Inbox } from "./routes/v1-inbox";
import { v1Webhooks } from "./routes/v1-webhooks";

const app = new Hono<{ Bindings: Env }>();

async function checkInboundR2(bucket: R2Bucket): Promise<boolean> {
  try {
    await bucket.list({ limit: 1 });
    return true;
  } catch (error) {
    console.error("Inbound R2 check failed", error);
    return false;
  }
}

// Packaged Tauri webview fetches Worker console/mail routes cross-origin.
app.use("*", desktopCors);

app.get("/health", async (c) => {
  const [r2Configured, d1] = await Promise.all([
    checkInboundR2(c.env.INBOUND),
    probeD1Connection(
      c.env.RELAYBASE_LOGS,
      c.env.RELAYBASE_MAIL,
      c.env.RELAYBASE_DB,
      c.env.CF_ACCOUNT_ID,
      c.env.CF_API_TOKEN,
    ),
  ]);
  return c.json({
    ok: true,
    version: c.env.WORKER_VERSION?.trim() || "unknown",
    inbound: {
      r2Configured,
      bucketName: c.env.INBOUND_BUCKET_NAME,
    },
    d1,
    // Binding present ≠ schema ready. `configured` is table-ready.
    d1Bound: {
      logs: Boolean(c.env.RELAYBASE_LOGS),
      mail: Boolean(c.env.RELAYBASE_MAIL),
      // Legacy alias for desktop clients still reading the old name.
      inboxIndex: Boolean(c.env.RELAYBASE_MAIL),
      app: Boolean(c.env.RELAYBASE_DB),
    },
    // Proves this isolate has ledger catch-up (stamp baseline, skip already-exists).
    schemaMigrate: "reconcile-v1",
  });
});

// End-user management (owner-session auth).
app.route("/console/keys", consoleKeys);
app.route("/console/ops-logs", consoleOpsLogs);
app.route("/console/send-logs", consoleSendLogs);
app.route("/console/branding", consoleBranding);
app.route("/console/connect", consoleConnect);
app.route("/console/init-db", consoleInitDb);
app.route("/console/migrate-db", consoleMigrateDb);
app.route("/console/register-owner", consoleRegisterOwner);
// Owner login / session / passtoken recovery (public or self-contained auth).
app.route("/console", consoleOwnerAuth);
app.route("/console/mailbox", consoleMailbox);
app.route("/console/domains", consoleDomains);
app.route("/console/zones", consoleZones);
app.route("/console/sending-onboard", consoleSendingOnboard);
app.route("/console/addresses", consoleAddresses);
app.route("/console/audience-groups", consoleAudienceGroups);
app.route("/console/broadcasts", consoleBroadcasts);
app.route("/console/stats", consoleStats);
app.route("/console/rebuild-mail", consoleRebuildMail);
app.route("/console/mailbox-health", consoleMailboxHealth);
app.route("/console/settings", consoleSettings);

// End-user mail operations (owner-session auth).
app.route("/mail/addresses", mailAddresses);
app.route("/mail/sending-health", mailSendingHealth);
app.route("/mail/inbox", mailInbox);
app.route("/mail/send", mailSend);
app.route("/mail/sent", mailSent);
app.route("/mail/favicon", mailFavicon);

// Flutter mobile app (mobile-password auth). Peer to /v1/*.
app.route("/mobile", mobile);

app.route("/v1/inbox", v1Inbox);
app.route("/v1/webhooks", v1Webhooks);
app.route("/v1/send", send);

app.notFound((c) => c.json({ error: "Not found" }, 404));

app.onError((err, c) => {
  console.error(err);
  const detail = err instanceof Error ? err.message : String(err);
  return c.json({ error: "Internal server error", detail }, 500);
});

export default app;
