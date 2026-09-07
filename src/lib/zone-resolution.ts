import type { CloudflareClient } from "./cloudflare-client.ts";

export type ZoneResolution = {
  zoneId: string;
  /** Zone name as returned by Cloudflare, e.g. `strum.us`. */
  zoneName: string;
  /** The domain the caller asked about, e.g. `mail.strum.us`. */
  domain: string;
  /** `true` when `zoneName !== domain` — the domain is a subdomain of the zone. */
  isSubdomain: boolean;
};

/**
 * Resolve a Cloudflare zone for a hostname that may be either an exact zone
 * name (`strum.us`) or a subdomain of a zone (`mail.strum.us`).
 *
 * Strategy:
 * 1. Exact match via `cf.resolveZoneId(domain)` — fastest, single API call.
 * 2. Walk up DNS labels (max 3 hops): `mail.strum.us` → `strum.us` → `us`.
 *    For each candidate, call `cf.resolveZoneId(candidate)`.
 * 3. Also check `cf.listZones()` cache (already fetched by sending-health)
 *    before making extra API calls.
 *
 * Returns `null` when neither the domain nor any parent is a zone on the
 * pinned account.
 */
export async function resolveZoneForDomain(
  cf: CloudflareClient,
  domainInput: string,
): Promise<ZoneResolution | null> {
  const domain = domainInput.trim().toLowerCase();
  if (!domain) return null;

  // 1. Exact match.
  const exactId = await cf.resolveZoneId(domain);
  if (exactId) {
    return { zoneId: exactId, zoneName: domain, domain, isSubdomain: false };
  }

  // 2. Walk up labels.
  const labels = domain.split(".");
  // Need at least 2 labels for a parent candidate (e.g. `strum.us` from `mail.strum.us`).
  // Stop before the TLD alone (`us`) — a single-label zone is not a real zone.
  const maxHops = Math.min(labels.length - 1, 3);
  for (let drop = 1; drop <= maxHops; drop++) {
    const candidate = labels.slice(drop).join(".");
    if (!candidate || candidate.indexOf(".") < 0) continue;

    // Check listZones cache first (avoids extra API call when zones are loaded).
    const cached = await findZoneInList(cf, candidate);
    if (cached) {
      return {
        zoneId: cached.id,
        zoneName: cached.name,
        domain,
        isSubdomain: true,
      };
    }

    // Fallback: direct API query.
    const candidateId = await cf.resolveZoneId(candidate);
    if (candidateId) {
      return {
        zoneId: candidateId,
        zoneName: candidate,
        domain,
        isSubdomain: true,
      };
    }
  }

  return null;
}

/**
 * Check `cf.listZones()` for a zone with the given name. Returns the matching
 * zone or `null`. Catches errors so callers can fall back to direct API.
 */
async function findZoneInList(
  cf: CloudflareClient,
  name: string,
): Promise<{ id: string; name: string } | null> {
  try {
    const zones = await cf.listZones();
    const match = zones.find(
      (z) => z.name.trim().toLowerCase() === name.toLowerCase(),
    );
    return match ? { id: match.id, name: match.name } : null;
  } catch {
    return null;
  }
}
