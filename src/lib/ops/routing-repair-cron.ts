/**
 * Periodic Email Routing self-heal.
 *
 * Cloudflare can leave a domain's Email Routing rules in a broken state
 * after a Worker script upload:
 *
 * 1. `enabled: false` — the well-known case; mail bounces with
 *    `550 5.1.1 Address not found`.
 * 2. `enabled: true` but **stale dispatch target** — the rule looks alive
 *    in the API and dashboard, yet Email Routing fails to hand the message
 *    to the Worker. The CF Activity Log shows "Delivery failed", but the
 *    Worker `email()` handler never runs, so no `ops_log` row, no R2 write,
 *    and no D1 index entry are produced. This is the silent-receive killer.
 *
 * The only reliable fix for case 2 is to PUT the rule again, which refreshes
 * the internal dispatch binding. This cron does that for **every** worker
 * rule on **every** domain (plus re-applies literal-To rules for any
 * registered address that lost its rule entirely), then records the result
 * to `ops_log` so the dashboard Log page surfaces the repair.
 */
import type { Env } from "../../env";
import { createAppDb } from "../../../db/app";
import { readMailbox } from "../catalog/catalog-store";
import { createCloudflareClient } from "../cloudflare/cloudflare-config";
import {
  ensureInboundRouting,
  refreshAllWorkerRules,
} from "../cloudflare/inbound-routing";
import { recordOpsLog } from "./ops-logs";

export async function runRoutingRepairCron(env: Env): Promise<void> {
  const appDb = createAppDb(env.RELAYBASE_DB);
  if (!appDb) return;

  const mailbox = await readMailbox(appDb);
  const domains = mailbox.domains
    .map((domain) => domain.trim().toLowerCase())
    .filter(Boolean);
  if (!domains.length) return;

  let cf;
  try {
    cf = await createCloudflareClient(env);
  } catch {
    // CF_API_TOKEN not configured — nothing to repair.
    return;
  }

  for (const domain of domains) {
    try {
      // 1. Re-PUT every worker-action rule (enabled or not, registered or
      //    orphaned) to refresh stale Worker dispatch bindings left by a
      //    script upload. This is the fix for the silent "Delivery failed"
      //    case where the rule appears enabled but the Worker never receives
      //    the message.
      const refresh = await refreshAllWorkerRules(cf, domain);

      // 2. Re-apply literal-To rules for every currently-registered address
      //    so any address that lost its rule entirely gets a fresh one.
      const entries = mailbox.addresses
        .filter((address) => address.domain === domain)
        .map((address) => ({
          address: address.email,
          inboundEnabled: address.inboundEnabled !== false,
        }));
      if (entries.length) {
        await ensureInboundRouting(
          cf,
          domain,
          entries,
          env.WORKER_SCRIPT_NAME,
        );
      }

      await recordOpsLog(env.RELAYBASE_LOGS, {
        kind: "routing_repair",
        ok: true,
        domain,
        metaJson: JSON.stringify({
          refreshedRules: refresh.reenabled.length,
          registeredAddresses: entries.length,
        }),
      });
    } catch (error) {
      await recordOpsLog(env.RELAYBASE_LOGS, {
        kind: "routing_repair",
        ok: false,
        domain,
        error:
          error instanceof Error ? error.message : "Failed to repair routing",
      });
    }
  }
}
