import { Hono } from "hono";
import type { Env } from "../../env";
import { requireConsoleSession } from "../../lib/auth";
import { probeD1Connection } from "../../lib/d1-status";
import { emailBindingConfigured } from "../../lib/email-send";
import { pinnedCfAccountId } from "../../lib/pinned-cf-account";
import { measureInboundR2Usage } from "../../lib/r2-usage";

const CF_API = "https://api.cloudflare.com/client/v4";

/** True when CF_API_TOKEN can call the Cloudflare API (Zone Read). */
async function probeCfApiTokenValid(token: string): Promise<boolean> {
  try {
    const res = await fetch(`${CF_API}/zones?per_page=1`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = (await res.json()) as { success?: boolean };
    return data.success === true;
  } catch {
    return false;
  }
}

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
  const apiToken = c.env.CF_API_TOKEN?.trim() ?? "";
  const cfApiTokenSet = Boolean(apiToken);
  const [usage, d1, cfApiTokenValid, accountId] = await Promise.all([
    r2Configured ? measureInboundR2Usage(c.env.INBOUND) : Promise.resolve(null),
    probeD1Connection(
      c.env.RELAYBASE_LOGS,
      c.env.RELAYBASE_MAIL,
      c.env.RELAYBASE_DB,
      c.env.CF_ACCOUNT_ID,
      c.env.CF_API_TOKEN,
    ),
    cfApiTokenSet ? probeCfApiTokenValid(apiToken) : Promise.resolve(false),
    pinnedCfAccountId(c.env),
  ]);

  return c.json({
    ok: true,
    product: "relaybase",
    version: c.env.WORKER_VERSION?.trim() || "unknown",
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
    // Worker has a CF_API_TOKEN secret (domain / routing / DNS API).
    cfApiTokenSet,
    // Secret is present and Cloudflare accepted a Zone Read probe.
    cfApiTokenValid,
    emailBindingConfigured: emailBindingConfigured(c.env),
  });
});

export { consoleConnect };
