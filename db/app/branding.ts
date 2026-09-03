import { eq } from "drizzle-orm";
import type { AppDb } from "./index";
import { domainBranding } from "./schema";
import type { DomainBrandingConfig, DmarcPolicy } from "../../src/lib/branding";

function defaultBrandingForDomain(domain: string): DomainBrandingConfig {
  return {
    dmarcPolicy: "quarantine",
    dmarcRua: `dmarc@${domain}`,
  };
}

export async function getDomainBranding(
  db: AppDb,
  domain: string,
): Promise<DomainBrandingConfig> {
  if (!db) return defaultBrandingForDomain(domain);
  const row = await db
    .select()
    .from(domainBranding)
    .where(eq(domainBranding.domain, domain.toLowerCase()))
    .get();
  if (!row) return defaultBrandingForDomain(domain);
  return {
    dmarcPolicy: row.dmarcPolicy as DmarcPolicy,
    dmarcRua: row.dmarcRua,
  };
}

export async function mergeDomainBranding(
  db: AppDb,
  domain: string,
  patch: Partial<DomainBrandingConfig>,
): Promise<DomainBrandingConfig> {
  if (!db) return defaultBrandingForDomain(domain);
  const key = domain.toLowerCase();
  const existing = await getDomainBranding(db, key);
  const next: DomainBrandingConfig = {
    dmarcPolicy: patch.dmarcPolicy ?? existing.dmarcPolicy,
    dmarcRua: patch.dmarcRua?.trim() || existing.dmarcRua,
  };
  await db
    .insert(domainBranding)
    .values({
      domain: key,
      dmarcPolicy: next.dmarcPolicy,
      dmarcRua: next.dmarcRua,
    })
    .onConflictDoUpdate({
      target: domainBranding.domain,
      set: {
        dmarcPolicy: next.dmarcPolicy,
        dmarcRua: next.dmarcRua,
      },
    })
    .run();
  return next;
}
