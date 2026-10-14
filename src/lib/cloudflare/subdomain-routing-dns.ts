import type { CloudflareClient } from "./cloudflare-client.ts";
import { isCloudflareMxContent, normalizeDnsOwnerName } from "./mx-apex-dns.ts";
import { domainUsesParentZone } from "./zone-domain.ts";

const FALLBACK_MX: Array<{ content: string; priority: number }> = [
  { content: "route1.mx.cloudflare.net", priority: 12 },
  { content: "route2.mx.cloudflare.net", priority: 13 },
  { content: "route3.mx.cloudflare.net", priority: 14 },
];

/**
 * Email Routing auto-config only publishes MX/SPF on the zone apex. Subdomain
 * mail hosts (e.g. mail.example.com) need the same routing MX set on their name.
 */
export async function ensureEmailRoutingDnsForDomain(
  cf: CloudflareClient,
  zoneId: string,
  zoneName: string,
  mailDomain: string,
): Promise<void> {
  const domain = normalizeDnsOwnerName(mailDomain);
  const apex = normalizeDnsOwnerName(zoneName);
  if (!domainUsesParentZone(domain, apex)) return;

  const mxRecords = await cf.listDnsRecords(zoneId, { type: "MX", name: domain });
  if (mxRecords.some((r) => isCloudflareMxContent(r.content))) return;

  const fromApi = await cf.getEmailRoutingDnsRecords(zoneId, domain);
  const toApply =
    fromApi.length > 0
      ? fromApi
      : FALLBACK_MX.map((row) => ({
          type: "MX" as const,
          name: domain,
          content: row.content,
          priority: row.priority,
          ttl: 1,
        }));

  for (const rec of toApply) {
    const type = rec.type.toUpperCase();
    if (type !== "MX" && type !== "TXT") continue;
    await cf.upsertDnsRecord(zoneId, {
      type,
      name: rec.name,
      content: rec.content,
      priority: rec.priority,
      ttl: rec.ttl ?? 1,
    });
  }
}
