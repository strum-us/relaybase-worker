import { Hono } from "hono";
import type { Env } from "../../env";
import { requireConsoleSession } from "../../lib/auth";
import { createCloudflareClient } from "../../lib/cloudflare-config";
import { createAppDb } from "../../../db/app";
import {
  clearConflictingMxRecords,
  ensureInboundRouting,
  findConflictingMxRecords,
  listInboundRoutingForDomains,
  MxConflictError,
  reenableDisabledWorkerRules,
  type InboundRoutingResult,
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

// GET /console/domains/routing[?domain=] — Email Routing enablement + rule
// status per domain, so the dashboard can flag rules Cloudflare left
// `enabled: false` after a Worker script upload.
consoleDomains.get("/routing", async (c) => {
  const denied = await requireConsoleSession(c);
  if (denied) return denied;

  const mailbox = await readMailbox(createAppDb(c.env.RELAYBASE_DB));
  const requested = c.req.query("domain")?.trim().toLowerCase();
  const domains = requested
    ? [requested]
    : mailbox.domains.map((domain) => domain.trim().toLowerCase()).filter(Boolean);

  try {
    const cf = await createCloudflareClient(c.env);
    const results = await listInboundRoutingForDomains(cf, domains);
    return c.json({ domains: results });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to list routing";
    return c.json({ error: message }, 502);
  }
});

// POST /console/domains/routing/repair {domain} — turns any Email Routing
// rule Cloudflare left `enabled: false` back on (the post-upload bug, even
// for a rule whose address is no longer registered), then also re-applies a
// literal-To rule for every currently-registered address (covers an address
// that never got a rule in the first place).
consoleDomains.post("/routing/repair", async (c) => {
  const denied = await requireConsoleSession(c);
  if (denied) return denied;

  let body: { domain?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const domain = normalizeDomain(body.domain ?? "");
  if (!domain) {
    return c.json({ error: "domain is required" }, 400);
  }

  try {
    const cf = await createCloudflareClient(c.env);
    const reenabled = await reenableDisabledWorkerRules(cf, domain);

    const mailbox = await readMailbox(createAppDb(c.env.RELAYBASE_DB));
    const entries = mailbox.addresses
      .filter((address) => address.domain === domain)
      .map((address) => ({
        address: address.email,
        inboundEnabled: address.inboundEnabled !== false,
      }));
    const result: InboundRoutingResult | null = entries.length
      ? await ensureInboundRouting(cf, domain, entries, c.env.WORKER_SCRIPT_NAME)
      : null;

    return c.json({
      domain,
      zoneId: reenabled.zoneId,
      reenabledOrphanedRules: reenabled.reenabled,
      rules: result?.rules ?? [],
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to repair routing";
    return c.json({ error: message }, 502);
  }
});

export { consoleDomains };
