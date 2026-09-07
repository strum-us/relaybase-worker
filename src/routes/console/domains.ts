import { Hono } from "hono";
import type { Env } from "../../env";
import { requireConsoleSession } from "../../lib/auth";
import { createCloudflareClient } from "../../lib/cloudflare-config";
import { createAppDb } from "../../../db/app";
import {
  clearConflictingMxRecords,
  findConflictingMxRecords,
  MxConflictError,
  type MxConflictRecord,
} from "../../lib/inbound-routing";
import {
  addDomain,
  listDomainSummaries,
  normalizeDomain,
  readMailbox,
  removeDomain,
} from "../../lib/catalog-store";
import {
  createMxConflictErrorPayload,
  createMxConflictOnboarding,
} from "../../lib/domain-onboarding";
import { resolveZoneForDomain } from "../../lib/zone-resolution";

const consoleDomains = new Hono<{ Bindings: Env }>();

consoleDomains.get("/", async (c) => {
  const denied = await requireConsoleSession(c);
  if (denied) return denied;
  const data = await readMailbox(createAppDb(c.env.RELAYBASE_DB));
  const summaries = listDomainSummaries(data);

  if (c.env.CF_API_TOKEN) {
    try {
      const cf = await createCloudflareClient(c.env);
      await Promise.allSettled(
        summaries.map(async (summary) => {
          try {
            const zoneId = await cf.resolveZoneId(summary.domain);
            if (!zoneId) return;
            const conflicts = await findConflictingMxRecords(
              cf,
              zoneId,
              summary.domain,
            );
            if (conflicts.length > 0) {
              summary.onboarding = createMxConflictOnboarding(
                summary.domain,
                zoneId,
                conflicts,
              ) as never;
            }
          } catch {
            // ignore per-domain probe failure
          }
        }),
      );
    } catch {
      // ignore CF client init failure
    }
  }

  return c.json({ domains: summaries });
});

consoleDomains.post("/", async (c) => {
  const denied = await requireConsoleSession(c);
  if (denied) return denied;
  let body: { domain?: string; forceMxResolve?: boolean };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const domain = normalizeDomain(body.domain ?? "");
  if (!domain) {
    return c.json({ error: "domain is required" }, 400);
  }

  let cf;
  let zoneId: string | null = null;
  let mxConflicts: MxConflictRecord[] = [];

  try {
    cf = await createCloudflareClient(c.env);
    zoneId = await cf.resolveZoneId(domain);
  } catch {
    // ignore if CF_API_TOKEN is not configured or resolve fails
  }

  // Subdomain candidate detection: if exact zone resolution failed, try
  // parent-zone walk-up. If a parent zone exists, return a subdomain_candidate
  // response so the client can open the SubdomainOnboardDialog instead of
  // adding the domain to D1 with no zone.
  if (cf && !zoneId) {
    try {
      const resolution = await resolveZoneForDomain(cf, domain);
      if (resolution && resolution.isSubdomain) {
        return c.json(
          {
            error: `${domain} is a subdomain of ${resolution.zoneName}. Onboard it as a subdomain to enable Sending and Routing without conflicting with the parent domain's mail provider.`,
            code: "subdomain_candidate",
            domain,
            parentZone: resolution.zoneName,
            parentZoneId: resolution.zoneId,
          },
          400,
        );
      }
    } catch {
      // ignore parent-zone resolution failure — fall through to normal add
    }
  }

  if (cf && zoneId) {
    try {
      mxConflicts = await findConflictingMxRecords(cf, zoneId, domain);
      if (mxConflicts.length > 0) {
        if (body.forceMxResolve === true) {
          await clearConflictingMxRecords(cf, zoneId, domain);
          try {
            await cf.enableEmailRouting(zoneId);
          } catch {
            // ignore if already enabled
          }
        } else {
          const data = await addDomain(
            createAppDb(c.env.RELAYBASE_DB),
            domain,
          );
          const summaries = listDomainSummaries(data);
          return c.json(
            createMxConflictErrorPayload(domain, zoneId, mxConflicts, summaries),
            409,
          );
        }
      } else {
        try {
          const routing = await cf.getEmailRoutingSettings(zoneId);
          if (!routing.enabled) {
            await cf.enableEmailRouting(zoneId);
          }
        } catch (err) {
          if (err instanceof Error && err.message.includes(`[2008]`)) {
            const conflicts = await findConflictingMxRecords(
              cf,
              zoneId,
              domain,
            );
            const data = await addDomain(
              createAppDb(c.env.RELAYBASE_DB),
              domain,
            );
            const summaries = listDomainSummaries(data);
            return c.json(
              createMxConflictErrorPayload(domain, zoneId, conflicts, summaries),
              409,
            );
          }
        }
      }
    } catch (err) {
      if (err instanceof MxConflictError) {
        const data = await addDomain(
          createAppDb(c.env.RELAYBASE_DB),
          domain,
        );
        const summaries = listDomainSummaries(data);
        return c.json(
          createMxConflictErrorPayload(
            err.domain,
            zoneId,
            err.mxConflicts,
            summaries,
          ),
          409,
        );
      }
    }
  }

  try {
    const data = await addDomain(
      createAppDb(c.env.RELAYBASE_DB),
      domain,
    );
    const summaries = listDomainSummaries(data);
    return c.json({
      domains: summaries,
      onboarding:
        summaries.find((d) => d.domain === domain)?.onboarding ?? null,
      message: `Added ${domain}.`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return c.json({ error: message }, 400);
  }
});

consoleDomains.delete("/", async (c) => {
  const denied = await requireConsoleSession(c);
  if (denied) return denied;
  const domain = c.req.query("domain")?.trim();
  if (!domain) {
    return c.json({ error: "domain is required" }, 400);
  }
  const data = await removeDomain(createAppDb(c.env.RELAYBASE_DB), domain);
  return c.json({
    domains: listDomainSummaries(data),
    message: "Domain removed",
  });
});

export { consoleDomains };
