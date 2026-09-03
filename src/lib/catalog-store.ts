/** Domains + addresses for the desktop mail client (packaged app). */
import type { AppDb } from "../../db/app";
import {
  addDomain as dbAddDomain,
  getAddress as dbGetAddress,
  readMailbox as dbReadMailbox,
  removeAddress as dbRemoveAddress,
  removeDomain as dbRemoveDomain,
  replaceMailbox as dbReplaceMailbox,
  updateAddress as dbUpdateAddress,
  updateAddressProfile as dbUpdateAddressProfile,
  upsertAddresses as dbUpsertAddresses,
} from "../../db/app/mailbox";

export type MailboxAddress = {
  email: string;
  domain: string;
  displayName?: string;
  /** Per-account plain-text signature appended to new drafts. */
  signature?: string;
  /**
   * When false, Cloudflare Email Routing uses action `drop`.
   * Omit / true = receive via Worker. Missing on read ⇒ treat as true.
   */
  inboundEnabled?: boolean;
  /**
   * When false, the mobile app cannot see or send from this address.
   * Omit / true = mobile access allowed. Missing on read ⇒ treat as true
   * (so existing installs keep working until the desktop opts an account out).
   */
  mobileEnabled?: boolean;
};

/** Persist only `false`; omit means receive-on / mobile-on. */
export function normalizeMailboxAddress(input: {
  email: string;
  domain: string;
  displayName?: string;
  signature?: string;
  inboundEnabled?: boolean;
  mobileEnabled?: boolean;
}): MailboxAddress {
  const displayName =
    typeof input.displayName === "string" ? input.displayName.trim() : "";
  const signature =
    typeof input.signature === "string" ? input.signature : "";
  return {
    email: input.email.trim().toLowerCase(),
    domain: normalizeDomain(input.domain),
    ...(displayName ? { displayName } : {}),
    ...(signature ? { signature } : {}),
    ...(input.inboundEnabled === false ? { inboundEnabled: false } : {}),
    ...(input.mobileEnabled === false ? { mobileEnabled: false } : {}),
  };
}

export type MailboxData = {
  domains: string[];
  addresses: MailboxAddress[];
};

export type MailboxDomainSummary = {
  domain: string;
  active: boolean;
  addressCount: number;
  audienceCount: number;
  broadcastCount: number;
  sentCount: number;
  r2Provisioned: boolean;
  r2BucketName: string | null;
  r2WorkerReady: boolean;
  onboarding: {
    status: "ready";
    currentStep: null;
    currentStepLabel: null;
    lastError: null;
    lastErrorCode: null;
    zoneId: null;
    sendingSubdomainId: null;
    mxConflicts: [];
    steps: [];
  };
};

export function normalizeDomain(input: string): string {
  return input.trim().toLowerCase().replace(/\.$/, "");
}

export async function readMailbox(db: AppDb): Promise<MailboxData> {
  return dbReadMailbox(db);
}

/** Replace the entire mailbox blob (PUT /console/mailbox). */
export async function writeMailbox(
  db: AppDb,
  data: MailboxData,
): Promise<void> {
  await dbReplaceMailbox(db, data);
}

export async function addDomain(
  db: AppDb,
  domainInput: string,
): Promise<MailboxData> {
  await dbAddDomain(db, domainInput);
  return readMailbox(db);
}

export async function removeDomain(
  db: AppDb,
  domainInput: string,
): Promise<MailboxData> {
  await dbRemoveDomain(db, domainInput);
  return readMailbox(db);
}

export async function upsertAddresses(
  db: AppDb,
  domainInput: string,
  entries: Array<{
    email: string;
    displayName?: string;
    inboundEnabled?: boolean;
    mobileEnabled?: boolean;
  }>,
): Promise<{ data: MailboxData; added: MailboxAddress[] }> {
  const { added } = await dbUpsertAddresses(db, domainInput, entries);
  const data = await readMailbox(db);
  return { data, added };
}

export async function removeAddress(
  db: AppDb,
  emailInput: string,
): Promise<{ data: MailboxData; removed: MailboxAddress | null }> {
  const removed = await dbRemoveAddress(db, emailInput);
  const data = await readMailbox(db);
  return { data, removed };
}

/** Addresses the mobile app is allowed to see (mobileEnabled !== false). */
export function mobileEnabledAddresses(data: MailboxData): MailboxAddress[] {
  return data.addresses.filter((a) => a.mobileEnabled !== false);
}

/**
 * Merge profile fields (displayName, signature) into a single address record.
 * Used by the team `/mobile/profile` endpoint so a teammate can edit their own
 * identity without an owner session.
 */
export async function updateAddressProfile(
  db: AppDb,
  emailInput: string,
  patch: { displayName?: string; signature?: string },
): Promise<MailboxAddress | null> {
  return dbUpdateAddressProfile(db, emailInput, patch);
}

/** Unique domains that have at least one mobile-enabled address. */
export function mobileEnabledDomains(data: MailboxData): string[] {
  const set = new Set<string>();
  for (const address of mobileEnabledAddresses(data)) {
    set.add(address.domain);
  }
  return [...set].sort();
}

export function listDomainSummaries(data: MailboxData): MailboxDomainSummary[] {
  return data.domains.map((domain) => ({
    domain,
    active: false,
    addressCount: data.addresses.filter((a) => a.domain === domain).length,
    audienceCount: 0,
    broadcastCount: 0,
    sentCount: 0,
    r2Provisioned: true,
    r2BucketName: null,
    r2WorkerReady: true,
    // Packaged desktop has no Next onboarding pipeline — mark ready so
    // DomainStore.waitForOnboarding resolves and can seed addresses.
    onboarding: {
      status: "ready" as const,
      currentStep: null,
      currentStepLabel: null,
      lastError: null,
      lastErrorCode: null,
      zoneId: null,
      sendingSubdomainId: null,
      mxConflicts: [] as [],
      steps: [] as [],
    },
  }));
}

/** Re-export for routes that need a single address lookup. */
export async function getAddress(
  db: AppDb,
  email: string,
): Promise<MailboxAddress | null> {
  return dbGetAddress(db, email);
}

/** Full-field update for a single address (PATCH /console/addresses). */
export async function updateAddress(
  db: AppDb,
  emailInput: string,
  patch: {
    displayName?: string | null;
    signature?: string | null;
    inboundEnabled?: boolean;
    mobileEnabled?: boolean;
  },
): Promise<MailboxAddress | null> {
  return dbUpdateAddress(db, emailInput, patch);
}
