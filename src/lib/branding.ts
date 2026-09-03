import type { CloudflareClient, CfDnsRecord } from "./cloudflare-client";
import type { AppDb } from "../../db/app";
import {
  getDomainBranding as dbGetDomainBranding,
  mergeDomainBranding as dbMergeDomainBranding,
} from "../../db/app/branding";

export type DmarcPolicy = "none" | "quarantine" | "reject";

export type DomainBrandingConfig = {
  dmarcPolicy: DmarcPolicy;
  dmarcRua: string;
};

export type DomainBrandingMap = Record<string, DomainBrandingConfig>;

export type BrandingDnsRecordStatus = {
  type: "TXT";
  name: string;
  expected: string;
  current: string | null;
  found: boolean;
  recordId: string | null;
};

export type DomainBrandingStatus = {
  domain: string;
  zoneId: string | null;
  dnsConfigured: boolean;
  dnsCanApply: boolean;
  dnsApplyHint: string | null;
  settings: DomainBrandingConfig;
  dmarc: BrandingDnsRecordStatus;
  dmarcEnforced: boolean;
  notes: string[];
};

function dmarcRecordName(domain: string): string {
  return `_dmarc.${domain}`;
}

/** Only used to find and remove leftover records from the retired BIMI feature. */
function legacyBimiRecordName(domain: string): string {
  return `default._bimi.${domain}`;
}

export function buildDmarcContent(config: DomainBrandingConfig): string {
  const rua = config.dmarcRua.trim().replace(/^mailto:/i, "");
  return `v=DMARC1; p=${config.dmarcPolicy}; rua=mailto:${rua}; adkim=s; aspf=s`;
}

function txtRecordMatches(
  records: CfDnsRecord[],
  name: string,
  includes: string,
): CfDnsRecord | undefined {
  const target = name.toLowerCase();
  return records.find(
    (record) =>
      record.type === "TXT" &&
      record.name.toLowerCase() === target &&
      record.content.includes(includes),
  );
}

function parseDmarcPolicy(content: string): DmarcPolicy | null {
  const match = content.match(/;\s*p\s*=\s*(none|quarantine|reject)/i);
  if (!match) return null;
  return match[1].toLowerCase() as DmarcPolicy;
}

export async function getDomainBrandingConfig(
  db: AppDb,
  domain: string,
): Promise<DomainBrandingConfig> {
  return dbGetDomainBranding(db, domain);
}

export async function mergeDomainBranding(
  db: AppDb,
  domain: string,
  patch: Partial<DomainBrandingConfig>,
): Promise<DomainBrandingConfig> {
  return dbMergeDomainBranding(db, domain, patch);
}

export async function fetchDomainBrandingStatus(
  db: AppDb,
  cf: CloudflareClient,
  domain: string,
): Promise<DomainBrandingStatus> {
  const normalizedDomain = domain.trim().toLowerCase();
  const config = await getDomainBrandingConfig(db, normalizedDomain);
  const dmarcExpected = buildDmarcContent(config);
  const notes: string[] = [
    "DMARC authenticates this domain's mail (SPF/DKIM alignment) — it does not control any inbox logo.",
  ];

  const zoneId = await cf.resolveZoneId(normalizedDomain);
  if (!zoneId) {
    return {
      domain: normalizedDomain,
      zoneId: null,
      dnsConfigured: false,
      dnsCanApply: true,
      dnsApplyHint: null,
      settings: config,
      dmarc: {
        type: "TXT",
        name: dmarcRecordName(normalizedDomain),
        expected: dmarcExpected,
        current: null,
        found: false,
        recordId: null,
      },
      dmarcEnforced: false,
      notes: [
        ...notes,
        "Could not resolve the Cloudflare zone ID for this domain.",
      ],
    };
  }

  const records = await cf.listDnsRecords(zoneId);
  const dmarcRecord = txtRecordMatches(
    records,
    dmarcRecordName(normalizedDomain),
    "v=DMARC1",
  );
  const dmarcPolicy =
    (dmarcRecord && parseDmarcPolicy(dmarcRecord.content)) ?? null;
  const dmarcEnforced =
    dmarcPolicy === "quarantine" || dmarcPolicy === "reject";

  return {
    domain: normalizedDomain,
    zoneId,
    dnsConfigured: true,
    dnsCanApply: true,
    dnsApplyHint: null,
    settings: config,
    dmarc: {
      type: "TXT",
      name: dmarcRecordName(normalizedDomain),
      expected: dmarcExpected,
      current: dmarcRecord?.content ?? null,
      found: Boolean(dmarcRecord),
      recordId: dmarcRecord?.id ?? null,
    },
    dmarcEnforced,
    notes,
  };
}

/**
 * Removes any leftover `default._bimi.<domain>` TXT record from the retired
 * BIMI/inbox-logo feature. Safe to call repeatedly — a no-op once cleaned up.
 * See docs/bimi-vmc-do-not-build.md for why BIMI is not coming back.
 */
async function removeLegacyBimiRecord(
  cf: CloudflareClient,
  zoneId: string,
  domain: string,
): Promise<void> {
  const records = await cf.listDnsRecords(zoneId);
  const bimiRecord = txtRecordMatches(
    records,
    legacyBimiRecordName(domain),
    "v=BIMI1",
  );
  if (bimiRecord) {
    await cf.deleteDnsRecord(zoneId, bimiRecord.id);
  }
}

export async function applyDomainBrandingDns(
  db: AppDb,
  cf: CloudflareClient,
  domain: string,
): Promise<DomainBrandingStatus> {
  const normalizedDomain = domain.trim().toLowerCase();
  const config = await getDomainBrandingConfig(db, normalizedDomain);
  const zoneId = await cf.resolveZoneId(normalizedDomain);
  if (!zoneId) {
    throw new Error(
      `Could not resolve Cloudflare zone for ${normalizedDomain}.`,
    );
  }

  await cf.upsertDnsRecord(zoneId, {
    type: "TXT",
    name: dmarcRecordName(normalizedDomain),
    content: buildDmarcContent(config),
    ttl: 1,
  });

  await removeLegacyBimiRecord(cf, zoneId, normalizedDomain);

  return fetchDomainBrandingStatus(db, cf, normalizedDomain);
}
