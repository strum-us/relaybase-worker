import type { CfListedZone } from "./cloudflare-zones.ts";

/** Lowercase host without trailing dot (DNS / zone name). */
export function normalizeZoneHost(input: string): string {
  return input.trim().toLowerCase().replace(/\.$/, "");
}

/**
 * Longest suffix match: `mail.kloy.app` → zone `kloy.app`.
 * Returns null when `domain` is an apex zone name or no zone suffix matches.
 */
export function findParentZoneForDomain(
  domain: string,
  zones: Array<Pick<CfListedZone, "name">>,
): CfListedZone | null {
  const needle = normalizeZoneHost(domain);
  if (!needle) return null;

  let best: CfListedZone | null = null;
  let bestLen = 0;

  for (const zone of zones) {
    const zn = normalizeZoneHost(zone.name);
    if (!zn || needle === zn) continue;
    if (!needle.endsWith(`.${zn}`)) continue;
    if (zn.length > bestLen) {
      bestLen = zn.length;
      best = zone as CfListedZone;
    }
  }
  return best;
}

/** Mail domain is served via a parent Cloudflare zone (not its own zone). */
export function domainUsesParentZone(domain: string, zoneName: string): boolean {
  const d = normalizeZoneHost(domain);
  const z = normalizeZoneHost(zoneName);
  return Boolean(z && d !== z && d.endsWith(`.${z}`));
}
