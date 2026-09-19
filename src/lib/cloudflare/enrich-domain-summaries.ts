import type { MailboxDomainSummary } from "../catalog/catalog-store";
import type { CloudflareClient } from "./cloudflare-client";
import {
  createMxConflictOnboarding,
  createReadyOnboarding,
  createZoneNotFoundOnboarding,
  createZonePendingOnboarding,
} from "./domain-onboarding";

function keepMxConflict(summary: MailboxDomainSummary): boolean {
  return (
    summary.onboarding?.status === "failed" &&
    summary.onboarding.lastErrorCode === "MX_CONFLICT"
  );
}

/** Overlay real Cloudflare zone status onto catalog summaries (D1-only "ready" is not authoritative). */
export async function enrichDomainSummariesWithCloudflare(
  cf: CloudflareClient,
  summaries: MailboxDomainSummary[],
): Promise<void> {
  await Promise.allSettled(
    summaries.map(async (summary) => {
      if (keepMxConflict(summary)) return;
      try {
        const zone = await cf.getZoneByName(summary.domain);
        if (!zone?.id) {
          summary.onboarding = createZoneNotFoundOnboarding(summary.domain);
          return;
        }
        if (zone.status !== "active") {
          summary.onboarding = createZonePendingOnboarding(
            summary.domain,
            zone.id,
            zone.nameServers,
            zone.status,
          );
          return;
        }
        summary.onboarding = createReadyOnboarding(zone.id, zone.nameServers, zone.status);
      } catch {
        // Leave catalog default if CF probe fails.
      }
    }),
  );
}

export { createMxConflictOnboarding };
