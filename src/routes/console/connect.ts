import { Hono } from "hono";
import type { Env } from "../../env";
import { requireConsoleSession } from "../../lib/auth";
import { probeCfApiTokenPermissions } from "../../lib/cloudflare-probe";
import { probeD1Connection } from "../../lib/d1-status";
import { emailBindingConfigured } from "../../lib/email-send";
import { pinnedCfAccountId } from "../../lib/pinned-cf-account";
import { measureInboundR2Usage } from "../../lib/r2-usage";
import { createAppDb } from "../../../db/app";
import { readMailbox } from "../../lib/catalog-store";

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

  // Read known domains so the probe can disambiguate "no zones" from
  // "Zone Read permission missing" (Cloudflare returns an empty list in
  // the latter case when zone-scoped permissions exist).
  let knownDomains: string[] = [];
  try {
    const mailbox = await readMailbox(createAppDb(c.env.RELAYBASE_DB));
    knownDomains = mailbox.domains;
  } catch {
    // ignore — probe will treat empty as "unknown" for Zone Read
  }

  const [usage, d1, cfApiTokenProbe, accountId] = await Promise.all([
    r2Configured ? measureInboundR2Usage(c.env.INBOUND) : Promise.resolve(null),
    probeD1Connection(
      c.env.RELAYBASE_LOGS,
      c.env.RELAYBASE_MAIL,
      c.env.RELAYBASE_DB,
      c.env.CF_ACCOUNT_ID,
      c.env.CF_API_TOKEN,
    ),
    cfApiTokenSet
      ? probeCfApiTokenPermissions(apiToken, { knownDomains })
      : Promise.resolve(null),
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
    // Secret is present and Cloudflare accepted Zone Read + routing/DNS Edit.
    cfApiTokenValid: cfApiTokenProbe?.valid ?? false,
    // Per-row probe (Zone Read / Email Routing Rules Edit / DNS Edit).
    cfApiTokenPermissions: cfApiTokenProbe?.permissions ?? null,
    emailBindingConfigured: emailBindingConfigured(c.env),
  });
});

export { consoleConnect };
