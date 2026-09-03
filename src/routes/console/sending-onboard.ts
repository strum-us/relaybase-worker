import { Hono } from "hono";
import type { Env } from "../../env";
import { requireConsoleSession } from "../../lib/auth";
import {
  cloudflareSendErrorBody,
  isCloudflarePlanError,
} from "../../lib/cloudflare-api-hints";
import { createCloudflareClient } from "../../lib/cloudflare-config";
import { onboardSendingDomain } from "../../lib/sending-onboard";

const consoleSendingOnboard = new Hono<{ Bindings: Env }>();

/**
 * POST /console/sending-onboard
 *
 * Owner-only Email Sending onboard. Does not write D1 sending columns or
 * flip catalog onboarding.status. DNS deletes require confirmReplace.
 */
consoleSendingOnboard.post("/", async (c) => {
  const denied = await requireConsoleSession(c);
  if (denied) return denied;

  let body: { domain?: unknown; confirmReplace?: unknown; accountId?: unknown };
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
    const result = await onboardSendingDomain(cf, domain, {
      confirmReplace,
      accountId: bodyAccountId || cf.accountId || c.env.CF_ACCOUNT_ID,
    });
    if (result.ok) {
      return c.json({ domain: result.domain });
    }
    if (result.code === "no_zone") {
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
    if (result.code === "cf_workers_paid_required") {
      return c.json(
        {
          error: result.error,
          code: result.code,
          domain: result.domain,
        },
        403,
      );
    }
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
      error instanceof Error ? error.message : "Sending onboard failed";
    if (isCloudflarePlanError(message)) {
      const body = cloudflareSendErrorBody(message);
      return c.json(
        {
          error: body.error,
          code: body.code ?? "cf_workers_paid_required",
          domain,
        },
        403,
      );
    }
    return c.json({ error: message }, 502);
  }
});

export { consoleSendingOnboard };
