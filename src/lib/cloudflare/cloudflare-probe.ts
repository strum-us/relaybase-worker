import { normalizeCfAccountId } from "./cf-account-id.ts";
import { zoneBelongsToPinnedAccount } from "./cloudflare-zones.ts";

const CF_API = "https://api.cloudflare.com/client/v4";

export type CfTokenPermissionStatus =
  | "ok"
  | "missing"
  | "read_only"
  | "skipped"
  | "unknown";

export type CfApiTokenPermissions = {
  zoneRead: CfTokenPermissionStatus;
  emailRoutingRead: CfTokenPermissionStatus;
  emailRoutingEdit: CfTokenPermissionStatus;
  emailSendingEdit: CfTokenPermissionStatus;
  dnsEdit: CfTokenPermissionStatus;
};

export type CfApiTokenProbe = {
  valid: boolean;
  permissions: CfApiTokenPermissions;
};

type AuthResult = "allowed" | "denied" | "unknown";

function isAuthDeniedError(err: { code?: number; message?: string }): boolean {
  if (err.code === 9109 || err.code === 10000 || err.code === 10001) return true;
  return (
    typeof err.message === "string" &&
    /unauthorized|permission|forbidden|authentication/i.test(err.message)
  );
}

async function probeAuth(
  url: string,
  token: string,
  method: "GET" | "POST",
): Promise<AuthResult> {
  try {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
      },
      body: method === "POST" ? JSON.stringify({}) : undefined,
    });

    if (res.status === 401 || res.status === 403) return "denied";

    const data = (await res.json().catch(() => null)) as {
      errors?: Array<{ code?: number; message?: string }>;
    } | null;

    if (Array.isArray(data?.errors)) {
      for (const err of data.errors) {
        if (isAuthDeniedError(err)) return "denied";
      }
    }

    // Auth passed: validation, not-enabled, empty list, method quirks, etc.
    if (
      res.ok ||
      res.status === 400 ||
      res.status === 404 ||
      res.status === 405 ||
      res.status === 422
    ) {
      return "allowed";
    }

    return "unknown";
  } catch {
    return "unknown";
  }
}

function combineReadEdit(
  read: AuthResult,
  edit: AuthResult,
): CfTokenPermissionStatus {
  if (edit === "allowed") return "ok";
  if (edit === "denied" && read === "allowed") return "read_only";
  if (edit === "denied") return "missing";
  return "unknown";
}

function isPassing(status: CfTokenPermissionStatus): boolean {
  return status === "ok" || status === "skipped";
}

/** Zone Read cannot always be proven via GET /zones; inconclusive is not a failure. */
function isZoneReadPassing(status: CfTokenPermissionStatus): boolean {
  return isPassing(status) || status === "unknown";
}

const SKIPPED_PERMISSIONS: CfApiTokenPermissions = {
  zoneRead: "skipped",
  emailRoutingRead: "skipped",
  emailRoutingEdit: "skipped",
  emailSendingEdit: "skipped",
  dnsEdit: "skipped",
};

type CfZoneListRow = {
  id: string;
  name?: string;
  account?: { id?: string };
};

type ZoneListResponse = {
  success?: boolean;
  result?: CfZoneListRow[];
  errors?: Array<{ code?: number; message?: string }>;
} | null;

function zonesOnPinnedAccountList(
  zones: CfZoneListRow[] | undefined,
  pinnedAccountId: string | undefined,
): CfZoneListRow[] | undefined {
  const pinned = normalizeCfAccountId(pinnedAccountId) ?? "";
  if (!pinned || !zones) return zones;
  return zones.filter((zone) =>
    zoneBelongsToPinnedAccount(zone.account?.id, pinned),
  );
}

async function fetchZoneList(
  token: string,
  options?: { name?: string; pinnedAccountId?: string },
): Promise<{ status: number; data: ZoneListResponse }> {
  const pinned = normalizeCfAccountId(options?.pinnedAccountId) ?? "";
  const params = new URLSearchParams();
  if (options?.name) {
    params.set("name", options.name.trim());
  }
  if (pinned) {
    params.set("account.id", pinned);
  }
  if (!options?.name) {
    params.set("per_page", pinned ? "50" : "1");
    params.set("page", "1");
  }
  const query = params.toString();
  const res = await fetch(`${CF_API}/zones?${query}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = (await res.json().catch(() => null)) as ZoneListResponse;
  if (data?.result) {
    data.result = zonesOnPinnedAccountList(data.result, pinned) ?? [];
  }
  return { status: res.status, data };
}

/**
 * Proves that CF_API_TOKEN has required permissions, and reports which
 * Cloudflare token row failed:
 *
 * 1. Zone Read (GET /zones)
 *    - If the token can list zones → use the first zone for routing/DNS probes.
 *    - If the list is empty, try each known domain via GET /zones?name={domain}.
 *      - Any hit → Zone Read OK, use that zone for routing/DNS probes.
 *      - All miss → Zone Read is "unknown" (inconclusive). Listing without
 *        account.id or domain mismatch can look like missing Zone Read even when
 *        the token is fine; only hard 401/403 is reported as "missing".
 *
 * 2. Email Routing Rules Edit (GET + empty POST /zones/{id}/email/routing/rules)
 * 3. DNS Edit (GET + empty POST /zones/{id}/dns_records)
 *
 * Read-only DNS/Routing is reported as `read_only` (GET allowed, POST 403).
 *
 * @param token - CF_API_TOKEN value
 * @param options.knownDomains - Domains from the mailbox store, used to
 *   resolve a zone id when the account-scoped list is empty.
 * @param options.pinnedAccountId - CF account id (env or D1), same filter as
 *   `CloudflareClient.listZones` / `resolveZoneId`.
 */
export async function probeCfApiTokenPermissions(
  token: string,
  options?: { knownDomains?: string[]; pinnedAccountId?: string },
): Promise<CfApiTokenProbe> {
  const trimmed = token.trim();
  if (!trimmed) {
    return {
      valid: false,
      permissions: {
        zoneRead: "missing",
        emailRoutingRead: "skipped",
        emailRoutingEdit: "skipped",
        emailSendingEdit: "skipped",
        dnsEdit: "skipped",
      },
    };
  }

  try {
    const pinnedAccountId = options?.pinnedAccountId;
    const { status, data } = await fetchZoneList(trimmed, { pinnedAccountId });

    // Hard auth rejection → Zone Read is definitely missing.
    if (status === 401 || status === 403) {
      return {
        valid: false,
        permissions: {
          zoneRead: "missing",
          emailRoutingRead: "skipped",
          emailRoutingEdit: "skipped",
          emailSendingEdit: "skipped",
          dnsEdit: "skipped",
        },
      };
    }

    if (Array.isArray(data?.errors) && data.errors.some(isAuthDeniedError)) {
      return {
        valid: false,
        permissions: {
          zoneRead: "missing",
          emailRoutingRead: "skipped",
          emailRoutingEdit: "skipped",
          emailSendingEdit: "skipped",
          dnsEdit: "skipped",
        },
      };
    }

    if (data?.success !== true) {
      return {
        valid: false,
        permissions: {
          zoneRead: "unknown",
          emailRoutingRead: "skipped",
          emailRoutingEdit: "skipped",
          emailSendingEdit: "skipped",
          dnsEdit: "skipped",
        },
      };
    }

    let firstZone = data.result?.[0]?.id ?? null;

    // Empty zone list: could mean "no zones on account" or "Zone Read missing."
    // Cloudflare returns success + empty list when Zone Read is absent but
    // zone-scoped permissions exist. Try known domains to disambiguate.
    if (!firstZone) {
      const knownDomains = (options?.knownDomains ?? [])
        .map((d) => d.trim().toLowerCase())
        .filter(Boolean);

      if (knownDomains.length === 0) {
        // No known domains to test against, but /zones succeeded without auth error.
        // Treat Zone Read as OK and skip zone-scoped checks until a domain is added.
        return {
          valid: true,
          permissions: {
            zoneRead: "ok",
            emailRoutingRead: "skipped",
            emailRoutingEdit: "skipped",
            emailSendingEdit: "skipped",
            dnsEdit: "skipped",
          },
        };
      }

      // Try each known domain. If any returns a zone, Zone Read works.
      for (const domain of knownDomains) {
        const domainResult = await fetchZoneList(trimmed, {
          name: domain,
          pinnedAccountId,
        });
        if (
          domainResult.data?.success === true &&
          domainResult.data.result &&
          domainResult.data.result.length > 0
        ) {
          const want = domain.toLowerCase();
          const match =
            domainResult.data.result.find(
              (z) => z.name?.toLowerCase() === want,
            ) ?? domainResult.data.result[0];
          firstZone = match?.id ?? null;
          if (firstZone) break;
        }
      }

      if (!firstZone) {
        // Inconclusive: empty list is not proof of missing Zone Read (wrong
        // account filter, domain not on CF, token zone resources, etc.).
        return {
          valid: true,
          permissions: {
            zoneRead: "unknown",
            emailRoutingRead: "skipped",
            emailRoutingEdit: "skipped",
            emailSendingEdit: "skipped",
            dnsEdit: "skipped",
          },
        };
      }
    }

    const routingRulesGet = `${CF_API}/zones/${firstZone}/email/routing/rules`;
    const dnsGet = `${CF_API}/zones/${firstZone}/dns_records?per_page=1`;
    const dnsPost = `${CF_API}/zones/${firstZone}/dns_records`;

    const [routingRulesRead, routingRulesEdit, dnsRead, dnsEditAuth] =
      await Promise.all([
        probeAuth(routingRulesGet, trimmed, "GET"),
        probeAuth(routingRulesGet, trimmed, "POST"),
        probeAuth(dnsGet, trimmed, "GET"),
        probeAuth(dnsPost, trimmed, "POST"),
      ]);

    const permissions: CfApiTokenPermissions = {
      zoneRead: "ok",
      emailRoutingRead: routingRulesRead === "allowed" ? "ok" : "missing",
      emailRoutingEdit: combineReadEdit(routingRulesRead, routingRulesEdit),
      emailSendingEdit: "ok",
      dnsEdit: combineReadEdit(dnsRead, dnsEditAuth),
    };

    return {
      valid:
        isZoneReadPassing(permissions.zoneRead) &&
        isPassing(permissions.emailRoutingEdit) &&
        isPassing(permissions.dnsEdit),
      permissions,
    };
  } catch {
    return {
      valid: false,
      permissions: { ...SKIPPED_PERMISSIONS, zoneRead: "unknown" },
    };
  }
}

export async function probeCfApiTokenValid(token: string): Promise<boolean> {
  const probe = await probeCfApiTokenPermissions(token);
  return probe.valid;
}
