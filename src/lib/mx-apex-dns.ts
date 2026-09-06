/** Normalize a DNS owner name for apex comparison (strip trailing dot, lowercase). */
export function normalizeDnsOwnerName(name: string): string {
  return name.trim().toLowerCase().replace(/\.$/, "");
}

export function isCloudflareMxContent(content: string): boolean {
  return content
    .trim()
    .toLowerCase()
    .replace(/\.$/, "")
    .endsWith("mx.cloudflare.net");
}

/** True when an MX record targets the zone apex, not a subdomain. */
export function isApexMxOwnerName(recordName: string, domain: string): boolean {
  const owner = normalizeDnsOwnerName(recordName);
  const apex = normalizeDnsOwnerName(domain);
  return owner === apex || owner === "@";
}
