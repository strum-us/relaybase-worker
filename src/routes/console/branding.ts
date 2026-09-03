import { Hono } from "hono";
import type { Env } from "../../env";
import { requireConsoleSession } from "../../lib/auth";
import { createCloudflareClient } from "../../lib/cloudflare-config";
import { createAppDb } from "../../../db/app";
import {
  applyDomainBrandingDns,
  fetchDomainBrandingStatus,
  mergeDomainBranding,
  type DmarcPolicy,
} from "../../lib/branding";

const consoleBranding = new Hono<{ Bindings: Env }>();

consoleBranding.get("/", async (c) => {
  const denied = await requireConsoleSession(c);
  if (denied) return denied;

  const domain = c.req.query("domain")?.trim();
  if (!domain) {
    return c.json({ error: "domain is required" }, 400);
  }

  let cf;
  try {
    cf = await createCloudflareClient(c.env);
  } catch (error) {
    return c.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Cloudflare is not configured on this worker.",
      },
      503,
    );
  }

  const status = await fetchDomainBrandingStatus(createAppDb(c.env.RELAYBASE_DB), cf, domain);
  return c.json(status);
});

consoleBranding.put("/", async (c) => {
  const denied = await requireConsoleSession(c);
  if (denied) return denied;

  const body = (await c.req.json()) as {
    domain?: string;
    dmarcPolicy?: DmarcPolicy;
    dmarcRua?: string;
  };
  const domain = body.domain?.trim().toLowerCase();
  if (!domain) {
    return c.json({ error: "domain is required" }, 400);
  }

  await mergeDomainBranding(createAppDb(c.env.RELAYBASE_DB), domain, {
    dmarcPolicy: body.dmarcPolicy,
    dmarcRua: body.dmarcRua,
  });

  let cf;
  try {
    cf = await createCloudflareClient(c.env);
  } catch (error) {
    return c.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Cloudflare is not configured on this worker.",
      },
      503,
    );
  }

  const status = await fetchDomainBrandingStatus(createAppDb(c.env.RELAYBASE_DB), cf, domain);
  return c.json(status);
});

consoleBranding.post("/", async (c) => {
  const denied = await requireConsoleSession(c);
  if (denied) return denied;

  const body = (await c.req.json()) as { domain?: string };
  const domain = body.domain?.trim().toLowerCase();
  if (!domain) {
    return c.json({ error: "domain is required" }, 400);
  }

  let cf;
  try {
    cf = await createCloudflareClient(c.env);
  } catch (error) {
    return c.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Cloudflare is not configured on this worker.",
      },
      503,
    );
  }

  const status = await applyDomainBrandingDns(createAppDb(c.env.RELAYBASE_DB), cf, domain);
  return c.json(status);
});

export { consoleBranding };
