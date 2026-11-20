import { Hono } from "hono";
import type { Env } from "../../env";
import { requireConsoleSession } from "../../lib/auth/auth";
import { cloudflareAccessTokenOrUndefined } from "../../lib/cloudflare/cloudflare-config";
import { readConnection } from "../../lib/grant/cf-grant";
import { CLOUDFLARE_FEATURE_SCOPES } from "../../lib/grant/scopes";
import { BUILD_VERSION } from "../../lib/update/version";
import { probeD1Connection } from "../../lib/d1/d1-status";
import { emailBindingConfigured } from "../../lib/mail/email-send";
import { pinnedCfAccountId } from "../../lib/cloudflare/pinned-cf-account";
import { measureInboundR2Usage } from "../../lib/ops/r2-usage";

const consoleConnect = new Hono<{ Bindings: Env }>();

async function checkInboundR2(bucket: R2Bucket): Promise<boolean> {
  try {
    await bucket.list({ limit: 1 });
    return true;
  } catch (error) {
    console.error("Inbound R2 check failed", error);
    return false;
  }
}

/**
 * Desktop self-install probe: proves the user controls this Worker via owner session.
 * Public GET /health is not sufficient (no admin proof).
 */
consoleConnect.get("/", async (c) => {
  const denied = await requireConsoleSession(c);
  if (denied) return denied;

  const r2Configured = await checkInboundR2(c.env.INBOUND);
  const pinnedAccountId = await pinnedCfAccountId(c.env);
  const connection = await readConnection(c.env);
  const accessToken = connection.connected ? await cloudflareAccessTokenOrUndefined(c.env) : undefined;

  const [usage, d1, accountId] = await Promise.all([
    r2Configured ? measureInboundR2Usage(c.env.INBOUND) : Promise.resolve(null),
    probeD1Connection(
      c.env.RELAYBASE_LOGS,
      c.env.RELAYBASE_MAIL,
      c.env.RELAYBASE_DB,
      c.env.CF_ACCOUNT_ID || connection.accountId || undefined,
      accessToken,
    ),
    Promise.resolve(pinnedAccountId),
  ]);
  const features = Object.fromEntries(
    Object.entries(CLOUDFLARE_FEATURE_SCOPES).map(([feature, scopes]) => [
      feature,
      connection.connected && scopes.every((scope) => connection.scopes.includes(scope)),
    ]),
  );

  return c.json({
    ok: true,
    product: "relaybase",
    version: BUILD_VERSION,
    workerScriptName: c.env.WORKER_SCRIPT_NAME || "relaybase-api",
    // Optional: env CF_ACCOUNT_ID or D1 owner_config.cf_account_id.
    // Desktop UI falls back to credentials.accountId when empty.
    accountId,
    inbound: {
      r2Configured,
      bucketName: c.env.INBOUND_BUCKET_NAME || "relaybase-mailbox",
      usage,
    },
    d1,
    // Stored Cloudflare OAuth grant (src/lib/grant/cf-grant.ts): connected, its scopes, and
    // which features those scopes cover. Not connected → the app offers "Reconnect Cloudflare".
    cloudflare: {
      connected: connection.connected,
      accountId: connection.accountId,
      scopes: connection.scopes,
      updatedAt: connection.updatedAt,
      features,
    },
    emailBindingConfigured: emailBindingConfigured(c.env),
  });
});

export { consoleConnect };
