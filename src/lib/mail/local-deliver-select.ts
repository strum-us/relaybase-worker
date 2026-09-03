import type { MailboxAddress } from "../catalog-store";

/**
 * Recipients on this install with inbound enabled. Order follows To then Cc.
 * Same-domain duplicates collapse to the first address; Message-ID dedupe in
 * `storeInboundMail` also collapses a later Cloudflare `email()` redelivery.
 */
export function selectLocalInboundRecipients(
  recipients: string[],
  addresses: MailboxAddress[],
  skip: Iterable<string> = [],
): string[] {
  const skipped = new Set(
    [...skip].map((address) => address.trim().toLowerCase()).filter(Boolean),
  );
  const enabled = new Set<string>();
  for (const row of addresses) {
    if (row.inboundEnabled === false) continue;
    const email = row.email.trim().toLowerCase();
    if (email) enabled.add(email);
  }
  const seen = new Set<string>();
  const local: string[] = [];
  for (const raw of recipients) {
    const email = raw.trim().toLowerCase();
    if (!email || skipped.has(email) || seen.has(email)) continue;
    if (!enabled.has(email)) continue;
    seen.add(email);
    local.push(email);
  }
  return local;
}
