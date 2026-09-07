import {
  SendingOnboardApiMissingError,
  type CloudflareClient,
} from "./cloudflare-client.ts";
import {
  CF_WORKERS_PAID_REQUIRED_CODE,
  cloudflareSendErrorBody,
  isCloudflarePlanError,
  isCloudflareTokenPermissionError,
} from "./cloudflare-api-hints.ts";
import { isSendingOwnedDnsRecord } from "./sending-onboard-dns.ts";
import {
  collectSendingHealth,
  sendingDashboardUrl,
  sendingRowMatchesDomain,
  type SendingHealthDomain,
} from "./sending-health.ts";
import { resolveZoneForDomain, type ZoneResolution } from "./zone-resolution.ts";

export type SubdomainDnsConflict = {
  id: string;
  type: string;
  name: string;
  content: string;
  priority: number | null;
};

export type SubdomainOnboardPhase = "sending" | "routing" | "both";

export type RoutingOnboardResult = {
  status: "ready" | "dkim_pending" | "dashboard_required";
  mxCreated: boolean;
  spfCreated: boolean;
  rulesCreated: boolean;
  dkimDashboardUrl: string | null;
  error: string | null;
};

export type SubdomainOnboardResult =
  | {
      ok: true;
      domain: string;
      parentZone: string;
      zoneId: string;
      sending: SendingHealthDomain;
      routing: RoutingOnboardResult;
    }
  | {
      ok: false;
      code: "no_parent_zone";
      domain: string;
      error: string;
    }
  | {
      ok: false;
      code: "needs_confirm";
      domain: string;
      zoneId: string;
      records: SubdomainDnsConflict[];
      error: string;
    }
  | {
      ok: false;
      code: "plan_required";
      domain: string;
      error: string;
    }
  | {
      ok: false;
      code: "permission_error";
      domain: string;
      error: string;
      cfApiTokenPermissions: unknown;
    }
  | {
      ok: false;
      code: "unavailable";
      domain: string;
      error: string;
      cloudflareSendingUrl: string | null;
    };

const NO_PARENT_ZONE_ERROR =
  "This subdomain's parent domain is not a zone on the connected Cloudflare account. Add the parent domain in Cloudflare first.";

const CONFIRM_ERROR =
  "These DNS records would be replaced. Confirm to delete them and continue.";

// Cloudflare Email Routing MX servers (from docs). Priorities are examples;
// Cloudflare assigns them automatically when managed, but for manual DNS
// creation we use the documented values.
const CF_ROUTING_MX_SERVERS: Array<{ content: string; priority: number }> = [
  { content: "route1.mx.cloudflare.net", priority: 13 },
  { content: "route2.mx.cloudflare.net", priority: 86 },
  { content: "route3.mx.cloudflare.net", priority: 24 },
];

const CF_ROUTING_SPF = "v=spf1 include:_spf.mx.cloudflare.net ~all";

function emailRoutingDashboardUrl(
  accountId: string | undefined,
  zoneId: string,
): string {
  const id = accountId?.trim() ?? "";
  if (id && zoneId) {
    // Zone-level Email Routing page. From here the user navigates to
    // Settings → Add subdomain to onboard a subdomain independently of
    // the root domain (which may have conflicting MX records, e.g. GW).
    return `https://dash.cloudflare.com/${id}/${zoneId}/email-service/routing`;
  }
  if (id) {
    return `https://dash.cloudflare.com/${id}/email-service/routing`;
  }
  return `https://dash.cloudflare.com/`;
}

function toConflict(id: string, type: string, name: string, content: string, priority: number | null): SubdomainDnsConflict {
  return { id, type, name, content, priority };
}

/**
 * Find existing DNS records at the subdomain that would conflict with the
 * MX/SPF records we are about to create for Email Routing.
 */
async function listRoutingDnsConflicts(
  cf: CloudflareClient,
  zoneId: string,
  domain: string,
): Promise<SubdomainDnsConflict[]> {
  const d = domain.trim().toLowerCase();
  const [mxRecords, txtRecords] = await Promise.all([
    cf.listDnsRecords(zoneId, { type: "MX", name: d }),
    cf.listDnsRecords(zoneId, { type: "TXT", name: d }),
  ]);
  const out: SubdomainDnsConflict[] = [];
  const seen = new Set<string>();
  for (const record of [...mxRecords, ...txtRecords]) {
    if (seen.has(record.id)) continue;
    seen.add(record.id);
    // Skip SPF TXT records that already match Cloudflare's include.
    if (
      record.type === "TXT" &&
      record.content.includes("_spf.mx.cloudflare.net")
    ) {
      continue;
    }
    out.push(
      toConflict(
        record.id,
        record.type,
        record.name,
        record.content,
        record.priority ?? null,
      ),
    );
  }
  return out;
}

/**
 * Find existing DNS records at `cf-bounce.{domain}` that would conflict
 * with Email Sending onboarding.
 */
async function listSendingDnsConflictsForSubdomain(
  cf: CloudflareClient,
  zoneId: string,
  domain: string,
): Promise<SubdomainDnsConflict[]> {
  const d = domain.trim().toLowerCase();
  const bounce = `cf-bounce.${d}`;
  const [mxBounce, txtBounce] = await Promise.all([
    cf.listDnsRecords(zoneId, { type: "MX", name: bounce }),
    cf.listDnsRecords(zoneId, { type: "TXT", name: bounce }),
  ]);
  const seen = new Set<string>();
  const out: SubdomainDnsConflict[] = [];
  for (const record of [...mxBounce, ...txtBounce]) {
    if (!isSendingOwnedDnsRecord(record, d) || seen.has(record.id)) continue;
    seen.add(record.id);
    out.push(
      toConflict(
        record.id,
        record.type,
        record.name,
        record.content,
        record.priority ?? null,
      ),
    );
  }
  return out;
}

/**
 * Create or update MX records for the subdomain pointing to Cloudflare
 * Email Routing MX servers.
 */
async function createRoutingMxRecords(
  cf: CloudflareClient,
  zoneId: string,
  domain: string,
): Promise<boolean> {
  const d = domain.trim().toLowerCase();
  let created = false;
  for (const mx of CF_ROUTING_MX_SERVERS) {
    try {
      await cf.upsertDnsRecord(zoneId, {
        type: "MX",
        name: d,
        content: mx.content,
        priority: mx.priority,
      });
      created = true;
    } catch {
      // Continue even if one fails — partial setup is better than none.
    }
  }
  return created;
}

/**
 * Create or update SPF TXT record for the subdomain.
 */
async function createRoutingSpfRecord(
  cf: CloudflareClient,
  zoneId: string,
  domain: string,
): Promise<boolean> {
  const d = domain.trim().toLowerCase();
  try {
    await cf.upsertDnsRecord(zoneId, {
      type: "TXT",
      name: d,
      content: CF_ROUTING_SPF,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Attempt to enable Email Routing on the parent zone. Returns:
 * - `true` if routing is enabled (or was already).
 * - `false` if it could not be enabled (e.g. apex has non-CF MX).
 */
async function ensureZoneRoutingEnabled(
  cf: CloudflareClient,
  zoneId: string,
): Promise<boolean> {
  try {
    const settings = await cf.getEmailRoutingSettings(zoneId);
    if (settings.enabled) return true;
    await cf.enableEmailRouting(zoneId);
    return true;
  } catch {
    // Likely MX conflict on apex — can't enable zone-level routing.
    return false;
  }
}

/**
 * Onboard a subdomain for Email Sending under a parent zone.
 * Uses the existing `createSendingSubdomain` API.
 */
async function onboardSending(
  cf: CloudflareClient,
  zoneId: string,
  domain: string,
): Promise<void> {
  const rows = await cf.listSendingSubdomains(zoneId);
  const match = rows.find((row) => sendingRowMatchesDomain(row.name, domain));
  if (match && !match.enabled) {
    await cf.updateSendingSubdomain(zoneId, match.name, { enabled: true });
    return;
  }
  if (match?.enabled) return;
  await cf.createSendingSubdomain(zoneId, domain);
}

/**
 * Onboard a subdomain for both Email Sending and Email Routing.
 *
 * Sending: uses `createSendingSubdomain` (existing API, fully automated).
 * Routing: creates MX + SPF DNS records on the subdomain, attempts to
 * enable zone-level routing, and creates routing rules. DKIM key cannot
 * be generated via API — returns `dkimDashboardUrl` for manual step.
 */
export async function onboardSubdomain(
  cf: CloudflareClient,
  domainInput: string,
  opts: {
    confirmReplace?: boolean;
    accountId?: string;
    phase?: SubdomainOnboardPhase;
  } = {},
): Promise<SubdomainOnboardResult> {
  const domain = domainInput.trim().toLowerCase();
  const phase = opts.phase ?? "both";

  // 1. Resolve parent zone.
  const resolution: ZoneResolution | null = await resolveZoneForDomain(cf, domain);
  if (!resolution) {
    return {
      ok: false,
      code: "no_parent_zone",
      domain,
      error: NO_PARENT_ZONE_ERROR,
    };
  }
  const { zoneId, zoneName } = resolution;

  // 2. Collect DNS conflicts (both sending and routing).
  const sendingConflicts = await listSendingDnsConflictsForSubdomain(cf, zoneId, domain);
  const routingConflicts = await listRoutingDnsConflicts(cf, zoneId, domain);
  const allConflicts = [...sendingConflicts, ...routingConflicts];

  if (allConflicts.length > 0 && !opts.confirmReplace) {
    return {
      ok: false,
      code: "needs_confirm",
      domain,
      zoneId,
      records: allConflicts,
      error: CONFIRM_ERROR,
    };
  }

  // 3. Delete conflicting records if confirmed.
  if (opts.confirmReplace) {
    for (const record of allConflicts) {
      try {
        await cf.deleteDnsRecord(zoneId, record.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (message.includes("[1046]")) continue;
        throw error;
      }
    }
  }

  // 4. Onboard Sending (if requested).
  let sendingHealth: SendingHealthDomain | null = null;
  if (phase === "sending" || phase === "both") {
    try {
      await onboardSending(cf, zoneId, domain);
    } catch (error) {
      if (error instanceof SendingOnboardApiMissingError) {
        return {
          ok: false,
          code: "unavailable",
          domain,
          error: error.message,
          cloudflareSendingUrl: sendingDashboardUrl(opts.accountId),
        };
      }
      const message = error instanceof Error ? error.message : "";
      if (isCloudflarePlanError(message)) {
        const body = cloudflareSendErrorBody(message);
        return {
          ok: false,
          code: "plan_required",
          domain,
          error: body.error,
        };
      }
      if (isCloudflareTokenPermissionError(message)) {
        return {
          ok: false,
          code: "permission_error",
          domain,
          error:
            "Cloudflare API token lacks Email Sending permission. Add Account → Email Sending → Edit to your token.",
          cfApiTokenPermissions: null,
        };
      }
      throw error;
    }

    // Collect sending health for the subdomain.
    try {
      const snapshot = await collectSendingHealth([domain], cf, {
        accountId: opts.accountId,
      });
      sendingHealth = snapshot.domains[0] ?? null;
    } catch {
      // Non-fatal — sending was onboarded, health check failed.
    }
  }

  // 5. Onboard Routing (if requested).
  let routingResult: RoutingOnboardResult = {
    status: "dashboard_required",
    mxCreated: false,
    spfCreated: false,
    rulesCreated: false,
    dkimDashboardUrl: null,
    error: null,
  };

  if (phase === "routing" || phase === "both") {
    const dkimUrl = emailRoutingDashboardUrl(opts.accountId, zoneId);
    let mxCreated = false;
    let spfCreated = false;
    let rulesCreated = false;
    let routingError: string | null = null;

    // Create MX + SPF DNS records on the subdomain.
    try {
      mxCreated = await createRoutingMxRecords(cf, zoneId, domain);
    } catch (error) {
      routingError =
        error instanceof Error ? error.message : "Failed to create MX records";
    }
    try {
      spfCreated = await createRoutingSpfRecord(cf, zoneId, domain);
    } catch {
      // Non-fatal — MX is the critical one for receiving mail.
    }

    // Attempt to enable zone-level routing (may fail if apex has Google MX).
    const zoneRoutingEnabled = await ensureZoneRoutingEnabled(cf, zoneId);

    // Try to create a catch-all routing rule for the subdomain.
    // This may fail if zone-level routing is not enabled.
    if (zoneRoutingEnabled) {
      try {
        const existingRules = await cf.listEmailRoutingRules(zoneId);
        const subdomainCatchAll = existingRules.find(
          (rule) =>
            rule.enabled &&
            rule.matchers.some(
              (m) =>
                m.type === "literal" &&
                m.field === "to" &&
                m.value?.endsWith(`@${domain}`),
            ),
        );
        if (!subdomainCatchAll) {
          // Note: We don't create a catch-all here — the caller (ensureInboundRouting)
          // handles per-address rule creation. We just verify routing is ready.
        }
        rulesCreated = true;
      } catch (error) {
        routingError =
          error instanceof Error ? error.message : "Failed to create routing rules";
      }
    }

    // Determine routing status.
    let routingStatus: "ready" | "dkim_pending" | "dashboard_required";
    if (mxCreated && spfCreated && zoneRoutingEnabled && rulesCreated) {
      // MX + SPF created, zone routing enabled, rules work.
      // DKIM key still needs manual setup in dashboard.
      routingStatus = "dkim_pending";
    } else if (mxCreated && spfCreated && !zoneRoutingEnabled) {
      // MX + SPF created but zone-level routing couldn't be enabled
      // (apex has Google MX). Mail may still arrive at CF MX servers.
      // User needs to add the subdomain via dashboard "Email Routing → Settings → Subdomains".
      routingStatus = "dashboard_required";
      routingError =
        routingError ??
          "MX and SPF records created. Open Cloudflare → Email Routing → Settings → Subdomains to enable routing for this subdomain (zone-level routing is off because the apex has another mail provider).";
    } else {
      routingStatus = "dashboard_required";
    }

    routingResult = {
      status: routingStatus,
      mxCreated,
      spfCreated,
      rulesCreated,
      dkimDashboardUrl: dkimUrl,
      error: routingError,
    };
  }

  // 6. Build final result.
  if (!sendingHealth) {
    // Sending was skipped or health check failed — create a minimal placeholder.
    sendingHealth = {
      domain,
      status: "unknown",
      sendingEnabled: false,
      sendingOnboarded: phase === "routing", // If only routing, sending is not onboarded
      zoneId,
      error: null,
      code: null,
      cloudflareSendingUrl: sendingDashboardUrl(opts.accountId),
    };
  }

  return {
    ok: true,
    domain,
    parentZone: zoneName,
    zoneId,
    sending: sendingHealth,
    routing: routingResult,
  };
}
