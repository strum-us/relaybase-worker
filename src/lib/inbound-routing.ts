import { CloudflareClient } from "./cloudflare-client.ts";
import {
  isApexMxOwnerName,
  isCloudflareMxContent,
  normalizeDnsOwnerName,
} from "./mx-apex-dns.ts";

export type InboundRoutingEntry = {
  address: string;
  /** When false, Email Routing action is `drop`. Default true → Worker. */
  inboundEnabled?: boolean;
};

export type InboundRoutingResult = {
  domain: string;
  zoneId: string;
  routingEnabled: boolean;
  rules: Array<{
    address: string;
    ruleId: string;
    action: "worker" | "drop";
  }>;
};

export type ListedInboundRoutingRule = {
  ruleId: string;
  enabled: boolean;
  address: string | null;
  matcherType: string;
  action: string;
  worker: string | null;
};

export type ListedInboundRouting = {
  domain: string;
  zoneId: string;
  routingEnabled: boolean;
  rules: ListedInboundRoutingRule[];
};

function describeRule(rule: CfEmailRoutingRule): ListedInboundRoutingRule {
  const literal = rule.matchers.find(
    (matcher) => matcher.type === "literal" && matcher.field === "to",
  );
  const action = rule.actions[0];
  const actionType = action?.type ?? "unknown";
  return {
    ruleId: rule.id,
    enabled: rule.enabled,
    address: literal?.value?.trim().toLowerCase() ?? null,
    matcherType: literal ? "literal" : (rule.matchers[0]?.type ?? "unknown"),
    action: actionType,
    worker:
      actionType === "worker" && Array.isArray(action?.value)
        ? action.value[0] ?? null
        : null,
  };
}

/** Read-only snapshot of Email Routing enablement + rules for one zone. */
export async function listInboundRouting(
  cf: CloudflareClient,
  domain: string,
): Promise<ListedInboundRouting> {
  const zoneId = await resolveZoneId(cf, domain);
  const [routing, existing] = await Promise.all([
    cf.getEmailRoutingSettings(zoneId),
    cf.listEmailRoutingRules(zoneId),
  ]);
  return {
    domain,
    zoneId,
    routingEnabled: routing.enabled,
    rules: existing.map(describeRule),
  };
}

export type InboundRoutingStatus =
  | ListedInboundRouting
  | { domain: string; error: string };

/**
 * Read-only snapshot for several zones at once. Per-domain failures (e.g. a
 * domain not yet on this Cloudflare account) are captured as `{domain,
 * error}` entries instead of rejecting the whole call.
 */
export async function listInboundRoutingForDomains(
  cf: CloudflareClient,
  domains: string[],
): Promise<InboundRoutingStatus[]> {
  return Promise.all(
    domains.map(async (domain): Promise<InboundRoutingStatus> => {
      try {
        return await listInboundRouting(cf, domain);
      } catch (error) {
        return {
          domain,
          error:
            error instanceof Error ? error.message : "Failed to list routing",
        };
      }
    }),
  );
}

type CfEmailRoutingRule = {
  id: string;
  enabled: boolean;
  matchers: Array<{ type: string; field?: string; value?: string }>;
  actions: Array<{ type: string; value?: string[] }>;
};

async function resolveZoneId(
  cf: CloudflareClient,
  domain: string,
): Promise<string> {
  const zoneId = await cf.resolveZoneId(domain);
  if (!zoneId) {
    throw new Error(
      `Could not resolve Cloudflare zone for ${domain} — ensure the domain is on this account`,
    );
  }
  return zoneId;
}

export type ReenabledInboundRule = {
  ruleId: string;
  address: string | null;
};

export type ReenableDisabledRoutingResult = {
  domain: string;
  zoneId: string;
  reenabled: ReenabledInboundRule[];
};

/**
 * Re-enable every Email Routing rule whose action is `worker` but that
 * Cloudflare left `enabled: false` (the post-script-upload bug), regardless
 * of whether the rule's address is still a registered mailbox address.
 *
 * This is the direct fix for the root cause — `ensureInboundRouting`'s
 * address-driven repair only touches rules for currently-registered
 * addresses and misses an orphaned rule left over from an address that was
 * later renamed or removed, even though that rule is still live in
 * Cloudflare and still bouncing mail.
 */
export async function reenableDisabledWorkerRules(
  cf: CloudflareClient,
  domain: string,
): Promise<ReenableDisabledRoutingResult> {
  const zoneId = await resolveZoneId(cf, domain);
  const existing = await cf.listEmailRoutingRules(zoneId);
  const reenabled: ReenabledInboundRule[] = [];

  for (const rule of existing) {
    if (rule.enabled) continue;
    if (!rule.actions.some((action) => action.type === "worker")) continue;

    await cf.updateEmailRoutingRule(zoneId, rule.id, {
      enabled: true,
      actions: rule.actions,
      matchers: rule.matchers,
    });
    const literal = rule.matchers.find(
      (matcher) => matcher.type === "literal" && matcher.field === "to",
    );
    reenabled.push({
      ruleId: rule.id,
      address: literal?.value?.trim().toLowerCase() ?? null,
    });
  }

  return { domain, zoneId, reenabled };
}

function matchesAddress(
  rule: CfEmailRoutingRule,
  address: string,
): boolean {
  return rule.matchers.some(
    (matcher) =>
      matcher.type === "literal" &&
      matcher.field === "to" &&
      matcher.value?.toLowerCase() === address.toLowerCase(),
  );
}

const MX_CONFLICT_ERROR_CODE = 2008;

function isMxConflictError(error: unknown): boolean {
  return error instanceof Error && error.message.includes(`[${MX_CONFLICT_ERROR_CODE}]`);
}

export type MxConflictRecord = {
  id: string;
  name: string;
  content: string;
  priority?: number;
};

function mapMxConflict(record: {
  id: string;
  name: string;
  content: string;
  priority?: number;
}): MxConflictRecord {
  return {
    id: record.id,
    name: record.name,
    content: record.content,
    priority: record.priority,
  };
}

/**
 * Apex MX records pointing to a non-Cloudflare mail provider. Only records at
 * the zone apex (name == domain or "@") are considered; subdomain MX records
 * do not conflict with Email Routing.
 */
export async function findConflictingMxRecords(
  cf: CloudflareClient,
  zoneId: string,
  domain: string,
): Promise<MxConflictRecord[]> {
  const apex = normalizeDnsOwnerName(domain);
  const [byApexName, allMx] = await Promise.all([
    cf.listDnsRecords(zoneId, { type: "MX", name: apex }),
    cf.listDnsRecords(zoneId, { type: "MX" }),
  ]);
  const seen = new Set<string>();
  const conflicts: MxConflictRecord[] = [];
  for (const record of [...byApexName, ...allMx]) {
    if (seen.has(record.id)) continue;
    seen.add(record.id);
    if (
      isApexMxOwnerName(record.name, domain) &&
      !isCloudflareMxContent(record.content)
    ) {
      conflicts.push(mapMxConflict(record));
    }
  }
  return conflicts;
}

/**
 * Delete apex MX records that point to a non-Cloudflare mail provider so that
 * Cloudflare Email Routing can be enabled. Only records at the zone apex
 * (name == domain or "@") are touched; subdomain MX records are left alone.
 */
export async function clearConflictingMxRecords(
  cf: CloudflareClient,
  zoneId: string,
  domain: string,
): Promise<{ removed: MxConflictRecord[] }> {
  const conflicts = await findConflictingMxRecords(cf, zoneId, domain);
  for (const record of conflicts) {
    await cf.deleteDnsRecord(zoneId, record.id);
  }
  return { removed: conflicts };
}

/** Thrown when Email Routing cannot be enabled due to non-Cloudflare MX records. */
export class MxConflictError extends Error {
  domain: string;
  zoneId: string;
  mxConflicts: MxConflictRecord[];

  constructor(domain: string, zoneId: string, mxConflicts: MxConflictRecord[]) {
    super(
      `Non-Cloudflare MX records exist for ${domain}. Remove them (or approve removal) to enable Email Routing.`,
    );
    this.name = "MxConflictError";
    this.domain = domain;
    this.zoneId = zoneId;
    this.mxConflicts = mxConflicts;
  }
}

/**
 * Ensure Email Routing is enabled and each address has a literal-To rule:
 * receive → Worker, inboundEnabled false → drop.
 *
 * When `forceMxResolve` is false (default) and enabling Email Routing fails
 * because non-Cloudflare MX records exist, throws `MxConflictError` carrying
 * the conflicting records so the caller can prompt the user for approval.
 * When `forceMxResolve` is true, those conflicting apex MX records are
 * deleted and the enable is retried.
 */
export async function ensureInboundRouting(
  cf: CloudflareClient,
  domain: string,
  entries: InboundRoutingEntry[],
  workerScriptName: string,
  opts: { forceMxResolve?: boolean } = {},
): Promise<InboundRoutingResult> {
  const zoneId = await resolveZoneId(cf, domain);
  const routing = await cf.getEmailRoutingSettings(zoneId);
  if (!routing.enabled) {
    try {
      await cf.enableEmailRouting(zoneId);
    } catch (error) {
      if (!isMxConflictError(error)) throw error;
      if (opts.forceMxResolve) {
        await clearConflictingMxRecords(cf, zoneId, domain);
        await cf.enableEmailRouting(zoneId);
      } else {
        const mxConflicts = await findConflictingMxRecords(cf, zoneId, domain);
        throw new MxConflictError(domain, zoneId, mxConflicts);
      }
    }
  }

  const existing = await cf.listEmailRoutingRules(zoneId);
  const rules: InboundRoutingResult["rules"] = [];

  for (const entry of entries) {
    const address = entry.address.trim().toLowerCase();
    if (!address) continue;
    const receive = entry.inboundEnabled !== false;
    const action = receive
      ? ({ type: "worker" as const, value: [workerScriptName] })
      : ({ type: "drop" as const });
    const ruleAction: "worker" | "drop" = receive ? "worker" : "drop";
    const ruleName = receive
      ? `Store ${address} in Worker`
      : `Drop inbound for ${address}`;

    const current = existing.find((rule) => matchesAddress(rule, address));
    if (current) {
      // CF can leave worker rules `enabled: false` after a script upload;
      // always turn them back on or inbound never reaches email().
      const updated = await cf.updateEmailRoutingRule(zoneId, current.id, {
        enabled: true,
        actions: [action],
        matchers: [{ type: "literal", field: "to", value: address }],
      });
      rules.push({
        address,
        ruleId: updated.id,
        action: ruleAction,
      });
      continue;
    }

    const created = await cf.createEmailRoutingRule(zoneId, {
      name: ruleName,
      enabled: true,
      priority: 0,
      matchers: [{ type: "literal", field: "to", value: address }],
      actions: [action],
    });
    rules.push({
      address,
      ruleId: created.id,
      action: ruleAction,
    });
  }

  return {
    domain,
    zoneId,
    routingEnabled: true,
    rules,
  };
}

/** @deprecated Prefer ensureInboundRouting — always wires Worker receive. */
export async function ensureInboundWorkerRouting(
  cf: CloudflareClient,
  domain: string,
  addresses: string[],
  workerScriptName: string,
): Promise<InboundRoutingResult> {
  return ensureInboundRouting(
    cf,
    domain,
    addresses.map((address) => ({ address, inboundEnabled: true })),
    workerScriptName,
  );
}

export type RemoveInboundRoutingResult = {
  domain: string;
  zoneId: string;
  removed: Array<{ address: string; ruleId: string }>;
};

/** Delete Cloudflare Email Routing rules for the given addresses (literal To matchers). */
export async function removeInboundWorkerRouting(
  cf: CloudflareClient,
  domain: string,
  addresses: string[],
): Promise<RemoveInboundRoutingResult> {
  const zoneId = await resolveZoneId(cf, domain);
  const existing = await cf.listEmailRoutingRules(zoneId);
  const targets = new Set(
    addresses.map((address) => address.trim().toLowerCase()).filter(Boolean),
  );
  const removed: RemoveInboundRoutingResult["removed"] = [];

  for (const address of targets) {
    const matches = existing.filter((rule) => matchesAddress(rule, address));
    for (const rule of matches) {
      await cf.deleteEmailRoutingRule(zoneId, rule.id);
      removed.push({ address, ruleId: rule.id });
    }
  }

  return { domain, zoneId, removed };
}
