import { Hono } from "hono";
import type { Env } from "../../env";
import { requireConsoleSession } from "../../lib/auth";
import {
  isCloudflarePlanError,
  isCloudflareTokenPermissionError,
} from "../../lib/cloudflare-api-hints";
import { createCloudflareClient } from "../../lib/cloudflare-config";
import { onboardSubdomain } from "../../lib/subdomain-onboard";

const consoleSubdomainOnboard = new Hono<{ Bindings: Env }>();

/**
 * POST /console/subdomain-onboard
 *
 * Onboard a subdomain (e.g. `mail.strum.us`) for Email Sending and Email
 * Routing under an existing parent Cloudflare zone (e.g. `strum.us`).
 *
 * Body: { domain, confirmReplace?, accountId?, phase? }
 * - phase: "sending" | "routing" | "both" (default "both")
 *
 * Returns:
 * - 200: { domain, parentZone, zoneId, sending, routing }
 * - 400: { error, code: "no_parent_zone", domain }
 * - 403: { error, code: "plan_required", domain }
 * - 409: { error, code: "needs_confirm", domain, zoneId, records }
 * - 502: { error, code: "permission_error" | "unavailable", domain, ... }
 */
consoleSubdomainOnboard.post("/", async (c) => {
  const denied = await requireConsoleSession(c);
  if (denied) return denied;

  let body: {
    domain?: unknown;
    confirmReplace?: unknown;
    accountId?: unknown;
    phase?: unknown;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const domain = typeof body.domain === "string" ? body.domain.trim() : "";
  if (!domain) {
    return c.json({ error: "domain is required" }, 400);
  }

  const confirmReplace = body.confirmReplace === true;
  const bodyAccountId =
    typeof body.accountId === "string" ? body.accountId : "";
  const phase =
    body.phase === "sending" || body.phase === "routing" || body.phase === "both"
      ? body.phase
      : "both";

  let cf;
  try {
    cf = await createCloudflareClient(c.env, { accountId: bodyAccountId });
  } catch (error) {
    return c.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Cloudflare API is not configured on this worker",
      },
      503,
    );
  }

  try {
    const result = await onboardSubdomain(cf, domain, {
      confirmReplace,
      accountId: bodyAccountId || cf.accountId || c.env.CF_ACCOUNT_ID,
      phase,
    });

    if (result.ok) {
      return c.json({
        domain: result.domain,
        parentZone: result.parentZone,
        zoneId: result.zoneId,
        sending: result.sending,
        routing: result.routing,
      });
    }

    if (result.code === "no_parent_zone") {
      return c.json(
        { error: result.error, code: result.code, domain: result.domain },
        400,
      );
    }

    if (result.code === "needs_confirm") {
      return c.json(
        {
          error: result.error,
          code: result.code,
          domain: result.domain,
          zoneId: result.zoneId,
          records: result.records,
        },
        409,
      );
    }

    if (result.code === "plan_required") {
      return c.json(
        { error: result.error, code: result.code, domain: result.domain },
        403,
      );
    }

    if (result.code === "permission_error") {
      return c.json(
        {
          error: result.error,
          code: result.code,
          domain: result.domain,
          cfApiTokenPermissions: result.cfApiTokenPermissions,
        },
        502,
      );
    }

    // unavailable
    return c.json(
      {
        error: result.error,
        code: result.code,
        domain: result.domain,
        cloudflareSendingUrl: result.cloudflareSendingUrl,
      },
      502,
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Subdomain onboard failed";
    if (isCloudflarePlanError(message)) {
      return c.json({ error: message, code: "plan_required", domain }, 403);
    }
    if (isCloudflareTokenPermissionError(message)) {
      return c.json(
        {
          error:
            "Cloudflare API token lacks a required permission. Check the permission rows below.",
          code: "permission_error",
          domain,
          cfApiTokenPermissions: null,
        },
        502,
      );
    }
    return c.json({ error: message }, 502);
  }
});

export { consoleSubdomainOnboard };
