/**
 * Periodic Email Routing self-heal.
 *
 * Cloudflare can leave a domain's literal-To Email Routing rules
 * `enabled: false` after a Worker script upload, which bounces inbound mail
 * with `550 5.1.1 Address not found`. This cron re-enables any such rule
 * directly — regardless of whether its address is still a registered
 * mailbox address, since an orphaned rule (address renamed/removed after
 * Cloudflare disabled it) is still live and still bouncing mail.
 */
import type { Env } from "../env";
import { createAppDb } from "../../db/app";
import { readMailbox } from "./catalog-store";
import { createCloudflareClient } from "./cloudflare-config";
import { listInboundRoutingForDomains, reenableDisabledWorkerRules } from "./inbound-routing";
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

  const statuses = await listInboundRoutingForDomains(cf, domains);
  for (const status of statuses) {
    if ("error" in status) continue;

    const hasDisabledWorkerRule = status.rules.some(
      (rule) => rule.action === "worker" && rule.enabled === false,
    );
    if (!hasDisabledWorkerRule) continue;

    try {
      const result = await reenableDisabledWorkerRules(cf, status.domain);
      await recordOpsLog(env.RELAYBASE_LOGS, {
        kind: "routing_repair",
        ok: true,
        domain: status.domain,
        metaJson: JSON.stringify({ repairedRules: result.reenabled.length }),
      });
    } catch (error) {
      await recordOpsLog(env.RELAYBASE_LOGS, {
        kind: "routing_repair",
        ok: false,
        domain: status.domain,
        error: error instanceof Error ? error.message : "Failed to repair routing",
      });
    }
  }
}
