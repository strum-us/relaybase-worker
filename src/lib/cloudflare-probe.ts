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

const SKIPPED_PERMISSIONS: CfApiTokenPermissions = {
  zoneRead: "skipped",
  emailRoutingRead: "skipped",
  emailRoutingEdit: "skipped",
  emailSendingEdit: "skipped",
  dnsEdit: "skipped",
};

type ZoneListResponse = {
  success?: boolean;
  result?: Array<{ id: string; name?: string }>;
  errors?: Array<{ code?: number; message?: string }>;
} | null;

async function fetchZoneList(
  token: string,
  params?: URLSearchParams,
): Promise<{ status: number; data: ZoneListResponse }> {
  const query = params ? `?${params.toString()}` : "?per_page=1";
  const res = await fetch(`${CF_API}/zones${query}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = (await res.json().catch(() => null)) as ZoneListResponse;
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
 *      - All miss → Zone Read is "missing" (token lacks Zone → Zone → Read).
 *        Cloudflare returns an empty list (not 403) when Zone Read is absent
 *        but zone-scoped permissions (DNS Edit, Email Routing Edit) exist.
 *
 * 2. Email Routing Rules Edit (GET + empty POST /zones/{id}/email/routing/rules)
 * 3. DNS Edit (GET + empty POST /zones/{id}/dns_records)
 *
 * Read-only DNS/Routing is reported as `read_only` (GET allowed, POST 403).
 *
 * @param token - CF_API_TOKEN value
 * @param options.knownDomains - Domains from the mailbox store, used to
 *   disambiguate "no zones" from "Zone Read permission missing."
 */
export async function probeCfApiTokenPermissions(
  token: string,
  options?: { knownDomains?: string[] },
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
    const { status, data } = await fetchZoneList(trimmed);

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
        // No known domains to test against. Can't confirm Zone Read.
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

      // Try each known domain. If any returns a zone, Zone Read works.
      for (const domain of knownDomains) {
        const params = new URLSearchParams({ name: domain });
        const domainResult = await fetchZoneList(trimmed, params);
        if (
          domainResult.data?.success === true &&
          domainResult.data.result &&
          domainResult.data.result.length > 0
        ) {
          firstZone = domainResult.data.result[0]!.id;
          break;
        }
      }

      if (!firstZone) {
        // Token can't list zones and can't resolve any known domain.
        // Zone Read is missing.
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
    }

    const routingStatusGet = `${CF_API}/zones/${firstZone}/email/routing`;
    const routingRulesGet = `${CF_API}/zones/${firstZone}/email/routing/rules`;
    const sendingSubdomainsPost = `${CF_API}/zones/${firstZone}/email/sending/subdomains`;
    const dnsGet = `${CF_API}/zones/${firstZone}/dns_records?per_page=1`;
    const dnsPost = `${CF_API}/zones/${firstZone}/dns_records`;

    // Email Sending: Edit is an Account-level permission. Use POST with an
    // empty body (not GET) because GET /email/sending/subdomains can return
    // 403 when Email Sending is not yet enabled for the zone, even when the
    // token has the permission. POST with empty body returns 400 (validation
    // error: name required) when the permission is present, 403 when missing.
    const [routingStatusRead, routingRulesRead, routingRulesEdit, sendingEdit, dnsRead, dnsEditAuth] =
      await Promise.all([
        probeAuth(routingStatusGet, trimmed, "GET"),
        probeAuth(routingRulesGet, trimmed, "GET"),
        probeAuth(routingRulesGet, trimmed, "POST"),
        probeAuth(sendingSubdomainsPost, trimmed, "POST"),
        probeAuth(dnsGet, trimmed, "GET"),
        probeAuth(dnsPost, trimmed, "POST"),
      ]);

    const permissions: CfApiTokenPermissions = {
      zoneRead: "ok",
      emailRoutingRead: routingStatusRead === "allowed" ? "ok" : "missing",
      emailRoutingEdit: combineReadEdit(routingRulesRead, routingRulesEdit),
      emailSendingEdit: sendingEdit === "allowed" ? "ok" : "missing",
      dnsEdit: combineReadEdit(dnsRead, dnsEditAuth),
    };

    return {
      valid:
        isPassing(permissions.zoneRead) &&
        isPassing(permissions.emailRoutingRead) &&
        isPassing(permissions.emailRoutingEdit) &&
        isPassing(permissions.emailSendingEdit) &&
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
