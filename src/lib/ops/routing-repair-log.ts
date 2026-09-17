import type { D1Database } from "@cloudflare/workers-types";

import type { ListedInboundRouting } from "../cloudflare/inbound-routing";
import { recordOpsLog } from "./ops-logs";

/** True when Cloudflare routing drifted from the Relaybase catalog (user-visible issues). */
export function inboundRoutingNeedsRepair(
  snapshot: ListedInboundRouting,
): boolean {
  if (!snapshot.routingEnabled) return true;
  if (snapshot.missingAddresses.length > 0) return true;
  return snapshot.rules.some(
    (rule) => rule.action === "worker" && !rule.enabled,
  );
}

export async function recordRoutingRepairOpsLog(
  db: D1Database | undefined,
  input: {
    domain: string;
    ok: boolean;
    before?: ListedInboundRouting;
    refreshedRules?: number;
    error?: string;
  },
): Promise<void> {
  if (!db) return;

  const { domain, ok, before, refreshedRules, error } = input;

  if (ok && before && !inboundRoutingNeedsRepair(before)) {
    return;
  }

  await recordOpsLog(db, {
    kind: "routing_repair",
    ok,
    domain,
    error: ok ? null : (error ?? "Failed to repair routing"),
    metaJson: ok
      ? JSON.stringify({
          routingWasDisabled: before ? !before.routingEnabled : undefined,
          missingAddresses: before?.missingAddresses.length,
          disabledWorkerRules: before
            ? before.rules.filter(
                (rule) => rule.action === "worker" && !rule.enabled,
              ).length
            : undefined,
          refreshedRules,
        })
      : null,
  });
}
