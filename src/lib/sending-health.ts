import {
  CF_WORKERS_PAID_REQUIRED_CODE,
  cloudflareSendErrorBody,
  isCloudflarePlanError,
} from "./cloudflare-api-hints.ts";

export type SendingHealthStatus =
  | "ready"
  | "restricted"
  | "no_zone"
  | "unknown";

export type SendingSubdomainRow = {
  name: string;
  enabled: boolean;
};

export type SendingHealthDomain = {
  domain: string;
  status: SendingHealthStatus;
  sendingEnabled: boolean;
  sendingOnboarded: boolean;
  zoneId: string | null;
  error: string | null;
  code: string | null;
  cloudflareSendingUrl: string | null;
};

export type SendingHealthSnapshot = {
  generatedAt: string;
  domains: SendingHealthDomain[];
};

const RESTRICTED_ERROR =
  "Email Sending is not onboarded. Until it is, Cloudflare only delivers to verified destination addresses — other Relaybase mailboxes do not count.";

const DISABLED_ERROR =
  "Email Sending is disabled for this domain. Until it is enabled, Cloudflare only delivers to verified destination addresses — other Relaybase mailboxes do not count.";

const NO_ZONE_ERROR =
  "This domain is not a zone on the connected Cloudflare account.";

export const UNKNOWN_ERROR = "Could not check Email Sending status.";

/** Apex exact match, or leftmost wildcard (`*.example.com`) for a label under it. */
export function sendingRowMatchesDomain(rowName: string, domain: string): boolean {
  const name = rowName.trim().toLowerCase();
  const needle = domain.trim().toLowerCase();
  if (!name || !needle) return false;
  if (name === needle) return true;
  if (name.startsWith("*.")) {
    const suffix = name.slice(1);
    return needle.endsWith(suffix) && needle !== name.slice(2);
  }
  return false;
}

export function evaluateSendingHealth(input: {
  domain: string;
  zoneId: string | null;
  sendingRows: SendingSubdomainRow[] | null;
  hasCfBounceMx: boolean | null;
}): Omit<SendingHealthDomain, "cloudflareSendingUrl"> {
  const domain = input.domain.trim().toLowerCase();
  if (!input.zoneId) {
    return {
      domain,
      status: "no_zone",
      sendingEnabled: false,
      sendingOnboarded: false,
      zoneId: null,
      error: NO_ZONE_ERROR,
      code: null,
    };
  }

  const matches = (input.sendingRows ?? []).filter((row) =>
    sendingRowMatchesDomain(row.name, domain),
  );
  const enabledMatch = matches.find((row) => row.enabled);
  if (enabledMatch) {
    return {
      domain,
      status: "ready",
      sendingEnabled: true,
      sendingOnboarded: true,
      zoneId: input.zoneId,
      error: null,
      code: null,
    };
  }
  const disabledMatch = matches.find((row) => !row.enabled);
  if (disabledMatch) {
    return {
      domain,
      status: "restricted",
      sendingEnabled: false,
      sendingOnboarded: true,
      zoneId: input.zoneId,
      error: DISABLED_ERROR,
      code: null,
    };
  }

  // Subdomain list omitted apex — Sending onboard still publishes cf-bounce MX.
  if (input.hasCfBounceMx === true) {
    return {
      domain,
      status: "ready",
      sendingEnabled: true,
      sendingOnboarded: true,
      zoneId: input.zoneId,
      error: null,
      code: null,
    };
  }

  if (input.sendingRows !== null || input.hasCfBounceMx === false) {
    return {
      domain,
      status: "restricted",
      sendingEnabled: false,
      sendingOnboarded: false,
      zoneId: input.zoneId,
      error: RESTRICTED_ERROR,
      code: null,
    };
  }

  return {
    domain,
    status: "unknown",
    sendingEnabled: false,
    sendingOnboarded: false,
    zoneId: input.zoneId,
    error: UNKNOWN_ERROR,
    code: null,
  };
}

export function unknownSendingHealthDomain(
  domain: string,
  error: string,
  cloudflareSendingUrl: string | null,
): SendingHealthDomain {
  return {
    domain: domain.trim().toLowerCase(),
    status: "unknown",
    sendingEnabled: false,
    sendingOnboarded: false,
    zoneId: null,
    error,
    code: null,
    cloudflareSendingUrl,
  };
}

export function planRequiredSendingHealthDomain(
  domain: string,
  zoneId: string,
  probeMessage: string,
  cloudflareSendingUrl: string | null,
): SendingHealthDomain {
  const body = cloudflareSendErrorBody(probeMessage);
  return {
    domain: domain.trim().toLowerCase(),
    status: "restricted",
    sendingEnabled: false,
    sendingOnboarded: false,
    zoneId,
    error: body.error,
    code: body.code ?? CF_WORKERS_PAID_REQUIRED_CODE,
    cloudflareSendingUrl,
  };
}

export function sendingDashboardUrl(accountId: string | undefined): string {
  const id = accountId?.trim() ?? "";
  if (id) return `https://dash.cloudflare.com/${id}/email-service/sending`;
  return "https://dash.cloudflare.com/";
}

export type SendingHealthCf = {
  listZones(): Promise<Array<{ id: string; name: string }>>;
  resolveZoneId?(domain: string): Promise<string | null>;
  listSendingSubdomains(zoneId: string): Promise<SendingSubdomainRow[]>;
  hasSendingBounceMx(zoneId: string, domain: string): Promise<boolean>;
};

export async function collectSendingHealth(
  domains: string[],
  cf: SendingHealthCf | null,
  opts: { accountId?: string; generatedAt?: string; probeError?: string } = {},
): Promise<SendingHealthSnapshot> {
  const generatedAt = opts.generatedAt ?? new Date().toISOString();
  const cloudflareSendingUrl = sendingDashboardUrl(opts.accountId);
  const unique = [
    ...new Set(domains.map((d) => d.trim().toLowerCase()).filter(Boolean)),
  ];

  if (!cf) {
    const error = opts.probeError ?? UNKNOWN_ERROR;
    return {
      generatedAt,
      domains: unique.map((domain) =>
        unknownSendingHealthDomain(domain, error, cloudflareSendingUrl),
      ),
    };
  }

  let zones: Array<{ id: string; name: string }>;
  try {
    zones = await cf.listZones();
  } catch (error) {
    const message = error instanceof Error ? error.message : UNKNOWN_ERROR;
    return {
      generatedAt,
      domains: unique.map((domain) =>
        unknownSendingHealthDomain(domain, message, cloudflareSendingUrl),
      ),
    };
  }

  const zoneByName = new Map(
    zones.map((zone) => [zone.name.trim().toLowerCase(), zone]),
  );

  const rows = await Promise.all(
    unique.map(async (domain) => {
      let zone = zoneByName.get(domain);
      if (!zone && cf.resolveZoneId) {
        const resolvedId = await cf.resolveZoneId(domain);
        if (resolvedId) zone = { id: resolvedId, name: domain };
      }
      if (!zone) {
        return {
          ...evaluateSendingHealth({
            domain,
            zoneId: null,
            sendingRows: [],
            hasCfBounceMx: false,
          }),
          cloudflareSendingUrl,
        };
      }

      let sendingRows: SendingSubdomainRow[] | null = null;
      try {
        sendingRows = await cf.listSendingSubdomains(zone.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (isCloudflarePlanError(message)) {
          return planRequiredSendingHealthDomain(
            domain,
            zone.id,
            message,
            cloudflareSendingUrl,
          );
        }
        sendingRows = null;
      }

      const apexEnabled = (sendingRows ?? []).some(
        (row) => sendingRowMatchesDomain(row.name, domain) && row.enabled,
      );
      let hasCfBounceMx: boolean | null = null;
      if (!apexEnabled) {
        try {
          hasCfBounceMx = await cf.hasSendingBounceMx(zone.id, domain);
        } catch {
          hasCfBounceMx = null;
        }
      }

      return {
        ...evaluateSendingHealth({
          domain,
          zoneId: zone.id,
          sendingRows,
          hasCfBounceMx,
        }),
        cloudflareSendingUrl,
      };
    }),
  );

  return { generatedAt, domains: rows };
}
