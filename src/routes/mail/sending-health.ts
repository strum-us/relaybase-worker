import { Hono } from "hono";
import type { Env } from "../../env";
import { requireMailSession } from "../../lib/auth";
import { createAppDb } from "../../../db/app";
import { readMailbox } from "../../lib/catalog-store";
import { createCloudflareClient } from "../../lib/cloudflare-config";
import {
  collectSendingHealth,
  UNKNOWN_ERROR,
} from "../../lib/sending-health";
import { normalizeCfAccountId } from "../../lib/cf-account-id.ts";

const mailSendingHealth = new Hono<{ Bindings: Env }>();

/**
 * GET /mail/sending-health
 *
 * Mail-scoped Email Sending probe so the inbox sidebar can warn without a
 * console unlock. Does not persist; destination-address lists are not used.
 */
mailSendingHealth.get("/", async (c) => {
  const denied = await requireMailSession(c);
  if (denied) return denied;

  const mailbox = await readMailbox(createAppDb(c.env.RELAYBASE_DB));
  let cf = null;
  let probeError: string | undefined;
  try {
    cf = await createCloudflareClient(c.env, {
      accountId: c.req.query("accountId"),
    });
  } catch (error) {
    probeError =
      error instanceof Error ? error.message : UNKNOWN_ERROR;
  }

  const snapshot = await collectSendingHealth(mailbox.domains, cf, {
    accountId:
      normalizeCfAccountId(c.req.query("accountId")) ??
      c.env.CF_ACCOUNT_ID,
    probeError,
  });
  return c.json(snapshot);
});

export { mailSendingHealth };
