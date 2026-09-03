/**
 * Records Email Sending owns on the bounce hostname. Apex `_dmarc` and
 * `_domainkey` TXT are Email Routing–managed (CF 1046) — never treat those
 * as deletable sending conflicts.
 */
export function isSendingOwnedDnsRecord(
  record: { type: string; name: string },
  domain: string,
): boolean {
  const d = domain.trim().toLowerCase();
  const name = record.name.trim().toLowerCase();
  const type = record.type.toUpperCase();
  if (!d || !name) return false;
  if (name !== `cf-bounce.${d}`) return false;
  return type === "MX" || type === "TXT";
}
