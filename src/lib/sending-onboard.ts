import {
  SendingOnboardApiMissingError,
  type CfDnsRecord,
  type CloudflareClient,
} from "./cloudflare-client";
import {
  CF_WORKERS_PAID_REQUIRED_CODE,
  CF_TOKEN_PERMISSION_ERROR_CODE,
  cloudflareSendErrorBody,
  isCloudflarePlanError,
  isCloudflareTokenPermissionError,
} from "./cloudflare-api-hints";
import { isSendingOwnedDnsRecord } from "./sending-onboard-dns";
import {
  collectSendingHealth,
  sendingDashboardUrl,
  sendingRowMatchesDomain,
  type SendingHealthDomain,
} from "./sending-health";
import { probeCfApiTokenPermissions } from "./cloudflare-probe";
import { resolveZoneForDomain } from "./zone-resolution";

export { isSendingOwnedDnsRecord } from "./sending-onboard-dns";

export type SendingDnsConflict = {
  id: string;
  type: string;
  name: string;
  content: string;
  priority: number | null;
};

export type SendingOnboardResult =
  | { ok: true; domain: SendingHealthDomain }
  | {
      ok: false;
      code: "no_zone";
      domain: string;
      error: string;
    }
  | {
      ok: false;
      code: "needs_confirm";
      domain: string;
      zoneId: string;
      records: SendingDnsConflict[];
      error: string;
    }
  | {
      ok: false;
      code: "unavailable";
      domain: string;
      error: string;
      cloudflareSendingUrl: string | null;
    }
  | {
      ok: false;
      code: typeof CF_WORKERS_PAID_REQUIRED_CODE;
      domain: string;
      error: string;
    }
  | {
      ok: false;
      code: "cf_token_permission_missing";
      domain: string;
      error: string;
      cfApiTokenPermissions: unknown;
    };

const NO_ZONE_ERROR =
  "This domain is not a zone on the connected Cloudflare account.";
const CONFIRM_ERROR =
  "These DNS records would be replaced. Confirm to delete them and continue.";

function toConflict(record: CfDnsRecord): SendingDnsConflict {
  return {
    id: record.id,
    type: record.type,
    name: record.name,
    content: record.content,
    priority: record.priority ?? null,
  };
}

export async function listSendingDnsConflicts(
  cf: CloudflareClient,
  zoneId: string,
  domain: string,
): Promise<SendingDnsConflict[]> {
  const d = domain.trim().toLowerCase();
  const bounce = `cf-bounce.${d}`;
  const [mxBounce, txtBounce] = await Promise.all([
    cf.listDnsRecords(zoneId, { type: "MX", name: bounce }),
    cf.listDnsRecords(zoneId, { type: "TXT", name: bounce }),
  ]);
  const seen = new Set<string>();
  const out: SendingDnsConflict[] = [];
  for (const record of [...mxBounce, ...txtBounce]) {
    if (!isSendingOwnedDnsRecord(record, d) || seen.has(record.id)) continue;
    seen.add(record.id);
    out.push(toConflict(record));
  }
  return out;
}

async function enableOrCreateSending(
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

export async function onboardSendingDomain(
  cf: CloudflareClient,
  domainInput: string,
  opts: {
    confirmReplace?: boolean;
    accountId?: string;
    cfApiToken?: string;
    knownDomains?: string[];
  } = {},
): Promise<SendingOnboardResult> {
  const domain = domainInput.trim().toLowerCase();
  // Try exact zone match first, then walk up to parent zone for subdomains.
  let zoneId = await cf.resolveZoneId(domain);
  if (!zoneId) {
    const resolution = await resolveZoneForDomain(cf, domain);
    zoneId = resolution?.zoneId ?? null;
  }
  if (!zoneId) {
    return { ok: false, code: "no_zone", domain, error: NO_ZONE_ERROR };
  }

  const records = await listSendingDnsConflicts(cf, zoneId, domain);
  if (records.length > 0 && !opts.confirmReplace) {
    return {
      ok: false,
      code: "needs_confirm",
      domain,
      zoneId,
      records,
      error: CONFIRM_ERROR,
    };
  }
  if (opts.confirmReplace) {
    for (const record of records) {
      try {
        await cf.deleteDnsRecord(zoneId, record.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (message.includes("[1046]")) continue;
        throw error;
      }
    }
  }

  try {
    await enableOrCreateSending(cf, zoneId, domain);
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
        code: CF_WORKERS_PAID_REQUIRED_CODE,
        domain,
        error: body.error,
      };
    }
    // Detect permission errors (code 10000) from the Email Sending API.
    // Run the probe inline so the desktop can show exactly which row failed.
    if (isCloudflareTokenPermissionError(message) && opts.cfApiToken) {
      let cfApiTokenPermissions = null;
      try {
        const probe = await probeCfApiTokenPermissions(
          opts.cfApiToken,
          { knownDomains: opts.knownDomains ?? [] },
        );
        cfApiTokenPermissions = probe.permissions;
      } catch {
        // ignore probe failure — still return the error code
      }
      return {
        ok: false,
        code: "cf_token_permission_missing",
        domain,
        error:
          "Cloudflare API token lacks Email Sending permission. Add Account → Email Sending → Edit to your token.",
        cfApiTokenPermissions,
      };
    }
    throw error;
  }

  const snapshot = await collectSendingHealth([domain], cf, {
    accountId: opts.accountId,
  });
  const row = snapshot.domains[0];
  if (!row) {
    return {
      ok: false,
      code: "unavailable",
      domain,
      error: "Onboard finished but sending health returned no row.",
      cloudflareSendingUrl: sendingDashboardUrl(opts.accountId),
    };
  }
  return { ok: true, domain: row };
}
