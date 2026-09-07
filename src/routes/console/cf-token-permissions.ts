import { Hono } from "hono";
import type { Env } from "../../env";
import { requireConsoleSession } from "../../lib/auth";
import { probeCfApiTokenPermissions } from "../../lib/cloudflare-probe";
import { createAppDb } from "../../../db/app";
import { readMailbox } from "../../lib/catalog-store";

const consoleCfTokenPermissions = new Hono<{ Bindings: Env }>();

/**
 * Per-row CF_API_TOKEN probe for Settings → Cloudflare verify.
 * Also returned on GET /console/connect; this route exists so desktop can
 * fetch permissions when an older connect payload omitted the field.
 */
consoleCfTokenPermissions.get("/", async (c) => {
  const denied = await requireConsoleSession(c);
  if (denied) return denied;

  const apiToken = c.env.CF_API_TOKEN?.trim() ?? "";
  if (!apiToken) {
    return c.json({ ok: false, error: "cf_api_token_not_set" }, 404);
  }

  // Read known domains so the probe can disambiguate "no zones" from
  // "Zone Read permission missing."
  let knownDomains: string[] = [];
  try {
    const mailbox = await readMailbox(createAppDb(c.env.RELAYBASE_DB));
    knownDomains = mailbox.domains;
  } catch {
    // ignore
  }

  const probe = await probeCfApiTokenPermissions(apiToken, { knownDomains });
  return c.json({
    ok: true,
    cfApiTokenSet: true,
    cfApiTokenValid: probe.valid,
    cfApiTokenPermissions: probe.permissions,
  });
});

export { consoleCfTokenPermissions };
